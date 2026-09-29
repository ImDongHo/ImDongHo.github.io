/**
 * MY MEMO 패스키 서버 (Supabase Edge Function: memo)
 *
 * 과제 8 — 소개 페이지의 비공개 메모를 비밀번호 없이 패스키로만 연다.
 *
 * 주소: https://<project>.supabase.co/functions/v1/memo/<경로>
 *
 * 지금 단계(뼈대)에서 되는 것
 *   GET /memos  → 로그인(세션 토큰) 없이 요청하면 401
 *
 * 다음 단계에서 붙일 것
 *   등록   POST /register/options, /register/verify, /register/cancel
 *   로그인 POST /login/options, /login/verify
 *   로그아웃 POST /logout
 *   메모   GET/POST /memos, PATCH/DELETE /memos/:id
 *
 * 배포할 때 "Verify JWT(JWT 검증)"는 꺼야 한다.
 * 이 함수는 Supabase 로그인 JWT가 아니라 자체 세션 토큰(Authorization: Bearer)을 직접 검사한다.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

// 이 출처(사이트)에서 온 브라우저 요청만 허용한다 (쉼표로 여러 개)
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://imdongho.github.io')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

const key = serverKey();
const db = key
  ? createClient(Deno.env.get('SUPABASE_URL')!, key, { auth: { persistSession: false } })
  : null;

// ---------------------------------------------------------------------------
// 공통 도우미
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
  }
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Authorization: Bearer <세션 토큰> → 로그인한 계정. 없거나 틀리거나 만료되면 401
async function requireSession(req: Request) {
  const match = (req.headers.get('Authorization') ?? '').match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
  if (!match) {
    throw new HttpError(401, '로그인이 필요합니다. 패스키로 먼저 들어오세요.', 'no_valid_session');
  }
  const { data: session } = await db!
    .from('sessions')
    .select('token_hash, user_id, credential_id, expires_at, users(username)')
    .eq('token_hash', await sha256Hex(match[1]))
    .maybeSingle();
  if (!session || new Date(session.expires_at) < new Date()) {
    throw new HttpError(401, '로그인이 필요합니다. 패스키로 먼저 들어오세요.', 'no_valid_session');
  }
  return session;
}

// ---------------------------------------------------------------------------
// 메모 (비공개 자료)
// ---------------------------------------------------------------------------

async function listMemos(req: Request) {
  const session = await requireSession(req);
  // 주소에 ?user=다른계정 을 붙여도 무시한다. 누구의 자료인지는 오직 세션이 정한다
  const { data, error } = await db!
    .from('memos')
    .select('id, body, created_at, updated_at')
    .eq('user_id', session.user_id)
    .order('id');
  if (error) throw new HttpError(500, '메모를 읽지 못했습니다.');
  // deno-lint-ignore no-explicit-any
  const owner = (session as any).users?.username;
  return json({ owner, count: data.length, memos: data });
}

// ---------------------------------------------------------------------------
// 라우터
// ---------------------------------------------------------------------------

function route(req: Request): Promise<Response> {
  // /functions/v1/memo/memos 또는 /memo/memos → /memos
  const path = new URL(req.url).pathname.replace(/^.*?\/memo(?=\/|$)/, '') || '/';
  const method = req.method;

  if (method === 'GET' && path === '/') {
    return Promise.resolve(json({ service: 'my-memo-passkey', ok: true }));
  }
  if (method === 'GET' && path === '/memos') return listMemos(req);

  throw new HttpError(404, '없는 주소입니다.');
}

async function handle(req: Request): Promise<Response> {
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  let res: Response;
  try {
    if (!db) throw new HttpError(500, '서버 키가 설정되지 않았습니다.', 'server_key_missing');
    res = await route(req);
  } catch (err) {
    if (err instanceof HttpError) {
      res = json({ error: err.message, status: err.status, reason: err.reason }, err.status);
    } else {
      console.error(err);
      res = json({ error: '서버 오류', status: 500 }, 500);
    }
  }
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

// Supabase Edge Runtime은 기본 내보내기의 fetch로 요청을 넘겨준다
export default { fetch: handle };
