/**
 * MY MEMO 패스키 서버 (Supabase Edge Function: memo)
 *
 * 과제 8 — 소개 페이지의 비공개 메모를 비밀번호 없이 패스키로만 연다.
 * 비밀번호는 어디에도 없다. 서버가 저장하는 것은 패스키 공개키, 일회용 질문, 세션 토큰의 해시뿐이다.
 *
 * 주소: https://<project>.supabase.co/functions/v1/memo/<경로>
 *
 *   등록     POST /register/options   질문(challenge)을 만들어 DB에 보관
 *            POST /register/verify    질문을 꺼내며 지우고, 기기 응답을 검증해 공개키만 저장
 *            POST /register/cancel    사용자가 패스키 창을 닫으면 보관 중인 질문을 버린다
 *   로그인   POST /login/options      매번 새 질문
 *            POST /login/verify       저장된 공개키로 서명 확인 → 세션 토큰 발급
 *   로그아웃 POST /logout             세션 삭제 → 같은 토큰은 이후 401
 *   내 정보  GET  /me                 로그인한 계정과 패스키 정보
 *   메모     GET  /memos              로그인한 계정의 메모만
 *            POST /memos              한 줄 메모 추가 (주인은 세션의 계정)
 *            GET/PATCH/DELETE /memos/:id  내 메모 하나 읽기·수정·삭제 (남의 메모는 403)
 *
 * 배포할 때 "Verify JWT(JWT 검증)"는 꺼야 한다.
 * 이 함수는 Supabase 로그인 JWT가 아니라 자체 세션 토큰(Authorization: Bearer)을 직접 검사한다.
 *
 * 설정 (Supabase → Edge Functions → Secrets)
 *   ALLOWED_USERS    새 계정을 만들 수 있는 이름 (쉼표로 여러 개). 예: dh
 *   RP_ID            패스키가 묶이는 도메인. 기본값 imdongho.github.io
 *   ALLOWED_ORIGINS  요청을 받을 사이트 주소. 기본값 https://imdongho.github.io
 * DB는 Supabase가 자동으로 넣어 주는 SUPABASE_URL과 서버 전용 키로 접근한다 (코드에 키를 넣지 않는다).
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.58.0';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from 'npm:@simplewebauthn/server@13.3.3';
import { isoBase64URL } from 'npm:@simplewebauthn/server@13.3.3/helpers';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 질문은 5분 동안만 유효
const SESSION_TTL_MS = 60 * 60 * 1000;  // 세션 토큰은 1시간
const DB_TIMEOUT_MS = 10 * 1000;        // DB 요청이 이보다 오래 걸리면 포기한다
const USERNAME_RE = /^[a-z0-9-]{2,32}$/;

// 등록 결과의 AAGUID로 패스키가 어디에 저장됐는지 알려 준다 (T08-C26)
const AAGUID_PROVIDERS: Record<string, string> = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 비밀번호 관리자',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac (기기 자체)',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 키체인',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud 키체인 (관리형)',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello (기기 자체)',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello (기기 자체)',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello (기기 자체)',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '00000000-0000-0000-0000-000000000000': '알 수 없음 (보안 키이거나 제공자가 밝히지 않음)',
};

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

interface Config {
  rpID: string;
  rpName: string;
  origins: string[];
  allowedUsers: string[];
}

const list = (value: string | undefined, fallback: string) =>
  (value ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);

function configFromEnv(): Config {
  return {
    rpID: Deno.env.get('RP_ID') ?? 'imdongho.github.io',
    rpName: Deno.env.get('RP_NAME') ?? 'IM DONGHO Portfolio',
    origins: list(Deno.env.get('ALLOWED_ORIGINS'), 'https://imdongho.github.io'),
    allowedUsers: list(Deno.env.get('ALLOWED_USERS'), ''),
  };
}

// 서버 전용 키. Edge Function 안에서만 쓰고 브라우저로는 절대 보내지 않는다.
function serverKey(): string | undefined {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const custom = Deno.env.get('SERVICE_KEY');
  if (custom) return custom;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    return keys.default ?? Object.values(keys)[0];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 공통 도우미
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function randomBase64url(bytes: number): string {
  return isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isoFromNow = (ms: number) => new Date(Date.now() + ms).toISOString();
const nowIso = () => new Date().toISOString();

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch { /* 아래에서 400 */ }
  throw new HttpError(400, '요청 본문이 JSON이 아닙니다.', 'bad_json');
}

function normalizeUsername(raw: unknown): string {
  const username = String(raw ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, '계정 이름은 영문 소문자·숫자·하이픈 2~32자입니다.', 'bad_username');
  }
  return username;
}

const providerOf = (aaguid: unknown) =>
  AAGUID_PROVIDERS[String(aaguid)] ?? `기타 인증기 (AAGUID ${aaguid})`;

// DB 응답에서 오류가 있으면 500으로 바꾼다 (자세한 내용은 서버 로그에만 남긴다)
// deno-lint-ignore no-explicit-any
function must<T>(res: { data: T; error: any }, what: string): T {
  if (res.error) {
    console.error(`DB 오류 (${what}):`, res.error);
    throw new HttpError(500, '서버 저장소 오류입니다. 잠시 뒤 다시 시도해 주세요.', 'db_error');
  }
  return res.data;
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// 요청 처리기
// ---------------------------------------------------------------------------

export function makeHandler(db: SupabaseClient, config: Config) {
  // 만료된 질문과 세션 정리
  async function sweep() {
    must(await db.from('challenges').delete().lt('expires_at', nowIso()), 'sweep challenges');
    must(await db.from('sessions').delete().lt('expires_at', nowIso()), 'sweep sessions');
  }

  // 질문을 꺼내면서 바로 지운다 → 같은 질문은 두 번 통하지 않는다 (T08-C31)
  async function consumeChallenge(challengeId: unknown, kind: 'register' | 'login'): Promise<Row> {
    if (typeof challengeId !== 'string' || !challengeId) {
      throw new HttpError(400, 'challengeId가 없습니다.', 'no_challenge_id');
    }
    const rows = must(
      await db.from('challenges').delete().eq('id', challengeId).eq('kind', kind)
        .select('challenge, user_id, username, webauthn_user_id, expires_at'),
      'consume challenge',
    ) as Row[];
    const row = rows[0];
    if (!row) {
      throw new HttpError(401, '이미 사용했거나 존재하지 않는 질문(challenge)입니다.', 'challenge_not_found_or_used');
    }
    if (new Date(row.expires_at) <= new Date()) {
      throw new HttpError(401, '질문(challenge)이 만료되었습니다. 처음부터 다시 시도하세요.', 'challenge_expired');
    }
    return row;
  }

  // Authorization: Bearer <세션 토큰> → 로그인한 계정. 없거나 틀리거나 만료되면 401 (T08-C16, C17, C33)
  async function requireSession(req: Request) {
    const match = (req.headers.get('Authorization') ?? '').match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
    const session = match
      ? must(
        await db.from('sessions')
          .select('token_hash, user_id, credential_id, users(username)')
          .eq('token_hash', await sha256Hex(match[1]))
          .gt('expires_at', nowIso())
          .maybeSingle(),
        'read session',
      ) as Row | null
      : null;
    if (!session) {
      throw new HttpError(401, '로그인이 필요합니다. 패스키로 먼저 들어오세요.', 'no_valid_session');
    }
    return {
      token_hash: session.token_hash as string,
      user_id: session.user_id as number,
      credential_id: session.credential_id as string,
      username: session.users?.username as string,
    };
  }

  async function userByName(username: string): Promise<Row | null> {
    return must(
      await db.from('users').select('id').eq('username', username).maybeSingle(),
      'read user',
    ) as Row | null;
  }

  async function credentialsOf(userId: number): Promise<Row[]> {
    return must(
      await db.from('credentials').select('id, transports').eq('user_id', userId).order('created_at'),
      'read credentials',
    ) as Row[];
  }

  // ----- 등록 (카드 2) ------------------------------------------------------

  async function registerOptions(req: Request) {
    await sweep();
    const body = await readJson(req);
    const username = normalizeUsername(body.username);

    // 허용된 이름이고, 아직 패스키가 하나도 없을 때만 첫 등록을 받는다
    if (!config.allowedUsers.includes(username)) {
      throw new HttpError(403, '이 이름으로는 계정을 만들 수 없습니다.', 'username_not_allowed');
    }
    const user = await userByName(username);
    if (user && (await credentialsOf(user.id)).length > 0) {
      throw new HttpError(403, '이미 패스키가 있는 계정입니다.', 'account_already_claimed');
    }

    const webauthnUserId = randomBase64url(32);
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName: username,
      userDisplayName: username,
      userID: isoBase64URL.toBuffer(webauthnUserId),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
      timeout: CHALLENGE_TTL_MS,
    });

    // 질문을 서버에 보관한다. 확인(verify)할 때 꺼내 쓰고 지운다 (T08-C19)
    const challengeId = randomBase64url(16);
    must(
      await db.from('challenges').insert({
        id: challengeId,
        challenge: options.challenge,
        kind: 'register',
        username,
        webauthn_user_id: webauthnUserId,
        expires_at: isoFromNow(CHALLENGE_TTL_MS),
      }),
      'save register challenge',
    );
    return json({ challengeId, options });
  }

  async function registerVerify(req: Request) {
    const body = await readJson(req);
    const row = await consumeChallenge(body.challengeId, 'register');

    const name = String(body.name ?? '').trim();
    if (name.length < 1 || name.length > 40) {
      throw new HttpError(400, '패스키 이름은 1~40자로 적어 주세요.', 'bad_passkey_name');
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        // deno-lint-ignore no-explicit-any
        response: body.response as any,
        expectedChallenge: row.challenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      throw new HttpError(400, `등록 응답 검증 실패: ${(err as Error).message}`, 'registration_verification_failed');
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new HttpError(400, '등록 응답 검증 실패', 'registration_not_verified');
    }

    const username = row.username as string;
    // 그 사이에 다른 기기가 먼저 등록했는지 한 번 더 확인
    let user = await userByName(username);
    if (user && (await credentialsOf(user.id)).length > 0) {
      throw new HttpError(403, '그 사이에 이 계정의 패스키가 먼저 등록되었습니다.', 'account_already_claimed');
    }
    if (!user) {
      user = must(
        await db.from('users')
          .upsert({ username, webauthn_user_id: row.webauthn_user_id }, { onConflict: 'username' })
          .select('id')
          .single(),
        'create user',
      ) as Row;
    }

    // 공개키만 저장한다. 개인키는 기기(패스키 보관함) 밖으로 나오지 않는다 (T08-C21~C23)
    const info = verification.registrationInfo;
    const publicKey = isoBase64URL.fromBuffer(info.credential.publicKey);
    // deno-lint-ignore no-explicit-any
    const transports = info.credential.transports ?? (body.response as any)?.response?.transports ?? [];
    const saved = must(
      await db.from('credentials').insert({
        id: info.credential.id,
        user_id: user.id,
        public_key: publicKey,
        counter: info.credential.counter,
        transports,
        device_type: info.credentialDeviceType,
        backed_up: info.credentialBackedUp,
        aaguid: info.aaguid,
        name,
      }).select('created_at').single(),
      'save credential',
    ) as Row;

    // 서버가 방금 저장한 값을 그대로 돌려준다 → 저장된 것이 공개키임을 확인할 수 있다
    return json({
      ok: true,
      username,
      stored: {
        credentialId: info.credential.id,
        name,
        publicKey_COSE_base64url: publicKey,
        counter: info.credential.counter,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
        provider: providerOf(info.aaguid),
        createdAt: saved.created_at,
      },
    }, 201);
  }

  async function registerCancel(req: Request) {
    const body = await readJson(req);
    const rows = must(
      await db.from('challenges').delete()
        .eq('id', String(body.challengeId ?? '')).eq('kind', 'register').select('id'),
      'cancel register',
    ) as Row[];
    return json({ ok: true, discardedChallenge: rows.length > 0, stored: null });
  }

  // ----- 로그인 / 로그아웃 (카드 3) -----------------------------------------

  async function loginOptions(req: Request) {
    await sweep();
    const body = await readJson(req);
    const username = normalizeUsername(body.username);
    const user = await userByName(username);
    const creds = user ? await credentialsOf(user.id) : [];
    if (!user || creds.length === 0) {
      throw new HttpError(404, '이 계정에 등록된 패스키가 없습니다.', 'no_passkeys');
    }

    const options = await generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports ?? undefined })),
      userVerification: 'required',
      timeout: CHALLENGE_TTL_MS,
    });

    // 로그인할 때도 매번 새 질문 (T08-C27)
    const challengeId = randomBase64url(16);
    must(
      await db.from('challenges').insert({
        id: challengeId,
        challenge: options.challenge,
        kind: 'login',
        user_id: user.id,
        expires_at: isoFromNow(CHALLENGE_TTL_MS),
      }),
      'save login challenge',
    );
    return json({ challengeId, options });
  }

  async function loginVerify(req: Request) {
    const body = await readJson(req);
    const row = await consumeChallenge(body.challengeId, 'login');

    // deno-lint-ignore no-explicit-any
    const response = body.response as any;
    const cred = response?.id
      ? must(
        await db.from('credentials')
          .select('id, user_id, public_key, counter, transports, name')
          .eq('id', String(response.id))
          .maybeSingle(),
        'read credential',
      ) as Row | null
      : null;
    if (!cred) {
      throw new HttpError(401, '등록되지 않은(또는 삭제된) 패스키입니다.', 'unknown_credential');
    }
    if (cred.user_id !== row.user_id) {
      throw new HttpError(403, '이 계정의 패스키가 아닙니다.', 'credential_belongs_to_other_user');
    }

    let verification;
    try {
      // 저장해 둔 공개키로 서명을 확인한다 (T08-C29)
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: row.challenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpID,
        credential: {
          id: cred.id,
          publicKey: isoBase64URL.toBuffer(cred.public_key),
          counter: Number(cred.counter),
          transports: cred.transports ?? undefined,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      throw new HttpError(401, `서명 검증 실패: ${(err as Error).message}`, 'signature_verification_failed');
    }
    if (!verification.verified) {
      throw new HttpError(401, '서명 검증 실패', 'signature_not_verified');
    }

    must(
      await db.from('credentials')
        .update({ counter: verification.authenticationInfo.newCounter, last_used_at: nowIso() })
        .eq('id', cred.id),
      'update counter',
    );

    // 로그인 뒤에는 무작위 세션 토큰으로 사람을 알아본다. DB에는 해시만 저장 (T08-C32)
    const token = randomBase64url(32);
    const expiresAt = isoFromNow(SESSION_TTL_MS);
    must(
      await db.from('sessions').insert({
        token_hash: await sha256Hex(token),
        user_id: cred.user_id,
        credential_id: cred.id,
        expires_at: expiresAt,
      }),
      'save session',
    );
    const user = must(
      await db.from('users').select('username').eq('id', cred.user_id).single(),
      'read username',
    ) as Row;

    return json({
      ok: true,
      username: user.username,
      passkey: cred.name,
      token,
      tokenType: 'Bearer',
      expiresAt,
    });
  }

  async function logout(req: Request) {
    const session = await requireSession(req);
    must(await db.from('sessions').delete().eq('token_hash', session.token_hash), 'delete session');
    return json({ ok: true, message: '로그아웃했습니다. 이 토큰은 더 이상 쓸 수 없습니다.' });
  }

  async function me(req: Request) {
    const session = await requireSession(req);
    const cred = must(
      await db.from('credentials')
        .select('name, aaguid, created_at, last_used_at, public_key')
        .eq('id', session.credential_id)
        .maybeSingle(),
      'read my credential',
    ) as Row | null;
    const { count, error } = await db.from('credentials')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.user_id);
    must({ data: null, error }, 'count credentials');
    return json({
      username: session.username,
      passkeyCount: count ?? 0,
      passkey: cred && {
        name: cred.name,
        provider: providerOf(cred.aaguid),
        createdAt: cred.created_at,
        lastUsedAt: cred.last_used_at,
        publicKey_COSE_base64url: cred.public_key,
      },
    });
  }

  // ----- 메모 (비공개 자료) -------------------------------------------------

  async function listMemos(req: Request) {
    const session = await requireSession(req);
    // 주소에 ?user=다른계정 을 붙여도 무시한다. 누구의 자료인지는 오직 세션이 정한다
    const memos = must(
      await db.from('memos')
        .select('id, body, created_at, updated_at')
        .eq('user_id', session.user_id)
        .order('id'),
      'read memos',
    ) as Row[];
    return json({ owner: session.username, count: memos.length, memos });
  }

  function memoBody(raw: unknown): string {
    const text = String(raw ?? '').trim();
    if (text.length < 1 || text.length > 200) {
      throw new HttpError(400, '메모는 1~200자로 적어 주세요.', 'bad_memo');
    }
    return text;
  }

  async function addMemo(req: Request) {
    const session = await requireSession(req);
    const body = await readJson(req);
    // 본문에 username, user_id 같은 값을 넣어 보내도 무시한다. 주인은 세션의 계정이다 (T08-C40)
    const memo = must(
      await db.from('memos')
        .insert({ user_id: session.user_id, body: memoBody(body.body) })
        .select('id, body, created_at, updated_at')
        .single(),
      'add memo',
    );
    return json({ owner: session.username, memo }, 201);
  }

  // 메모 하나를 찾아 주인인지 확인한다. 없으면 404, 남의 것이면 403 (T08-C37, C41)
  async function ownMemo(session: { user_id: number }, id: number) {
    const memo = must(
      await db.from('memos').select('id, user_id, body, created_at, updated_at').eq('id', id).maybeSingle(),
      'read memo',
    ) as Row | null;
    if (!memo) throw new HttpError(404, '없는 메모입니다.', 'memo_not_found');
    if (memo.user_id !== session.user_id) {
      throw new HttpError(403, '다른 계정의 메모는 읽거나 바꿀 수 없습니다.', 'not_owner');
    }
    return memo;
  }

  async function getMemo(req: Request, id: number) {
    const session = await requireSession(req);
    const { user_id: _owner, ...memo } = await ownMemo(session, id);
    return json({ owner: session.username, memo });
  }

  async function updateMemo(req: Request, id: number) {
    const session = await requireSession(req);
    const body = await readJson(req);
    await ownMemo(session, id);
    const memo = must(
      await db.from('memos')
        .update({ body: memoBody(body.body), updated_at: nowIso() })
        .eq('id', id)
        .eq('user_id', session.user_id)
        .select('id, body, created_at, updated_at')
        .single(),
      'update memo',
    );
    return json({ owner: session.username, memo });
  }

  async function deleteMemo(req: Request, id: number) {
    const session = await requireSession(req);
    await ownMemo(session, id);
    must(
      await db.from('memos').delete().eq('id', id).eq('user_id', session.user_id),
      'delete memo',
    );
    return json({ owner: session.username, deleted: { id } });
  }

  // ----- 라우터 -------------------------------------------------------------

  function route(req: Request): Promise<Response> {
    // /functions/v1/memo/memos 또는 /memo/memos → /memos
    const path = new URL(req.url).pathname.replace(/^.*?\/memo(?=\/|$)/, '') || '/';
    switch (`${req.method} ${path}`) {
      case 'GET /': return Promise.resolve(json({ service: 'my-memo-passkey', ok: true }));
      case 'POST /register/options': return registerOptions(req);
      case 'POST /register/verify': return registerVerify(req);
      case 'POST /register/cancel': return registerCancel(req);
      case 'POST /login/options': return loginOptions(req);
      case 'POST /login/verify': return loginVerify(req);
      case 'POST /logout': return logout(req);
      case 'GET /me': return me(req);
      case 'GET /memos': return listMemos(req);
      case 'POST /memos': return addMemo(req);
    }
    const memoId = path.match(/^\/memos\/(\d{1,15})$/);
    if (memoId) {
      const id = Number(memoId[1]);
      if (req.method === 'GET') return getMemo(req, id);
      if (req.method === 'PATCH') return updateMemo(req, id);
      if (req.method === 'DELETE') return deleteMemo(req, id);
    }
    throw new HttpError(404, '없는 주소입니다.', 'not_found');
  }

  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('Origin');
    const headers: Record<string, string> = { Vary: 'Origin' };
    if (origin && config.origins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      headers['Access-Control-Max-Age'] = '600';
    }
    return headers;
  }

  return async function handle(req: Request): Promise<Response> {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    let res: Response;
    try {
      res = await route(req);
    } catch (err) {
      if (err instanceof HttpError) {
        res = json({ error: err.message, status: err.status, reason: err.reason }, err.status);
      } else {
        console.error(err);
        const timedOut = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
        res = timedOut
          ? json({ error: '서버 저장소가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.', status: 503, reason: 'db_timeout' }, 503)
          : json({ error: '서버 오류', status: 500 }, 500);
      }
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  };
}

// ---------------------------------------------------------------------------
// Supabase에서 실행될 때: SUPABASE_URL + 서버 전용 키로 DB(REST)에 접근한다
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const KEY = serverKey();

const handler = SUPABASE_URL && KEY
  ? makeHandler(
    createClient(SUPABASE_URL, KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      // DB 요청마다 시간 제한을 둬서, 저장소가 느려도 함수가 한없이 기다리지 않게 한다
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(DB_TIMEOUT_MS) }) },
    }),
    configFromEnv(),
  )
  : () => Promise.resolve(json({ error: '서버 키가 설정되지 않았습니다.', status: 500, reason: 'server_key_missing' }, 500));

// Supabase Edge Runtime은 기본 내보내기의 fetch로 요청을 넘겨준다
export default { fetch: handler };
