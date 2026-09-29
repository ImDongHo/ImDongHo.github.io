/**
 * MY MEMO — 패스키로 잠긴 비공개 메모 (화면)
 *
 * 화면 네 가지를 모달 하나에서 바꿔 보여 준다.
 *   login    로그인 전: 계정 이름 + [패스키로 로그인]
 *   memos    로그인 후: 한 줄 메모 추가·수정·삭제
 *   setup    주소 #setup 으로만 열림: 첫 패스키 등록
 *   evidence 주소 #evidence 로만 열림(로그인 후): 확인용 요청·응답 기록
 *
 * 비공개 메모 내용은 이 파일에 없다. 로그인한 뒤 서버(GET /memos)가 내려 준다.
 * 메모는 HTML이 아니라 글자(textContent)로만 화면에 넣는다.
 */

(() => {
  const API = window.MY_MEMO_API;

  // 로그인 상태는 페이지 메모리에만 둔다. 새로고침하면 다시 패스키로 들어와야 한다
  const state = {
    view: 'login',
    token: null,
    username: null,
    memos: [],
    passkey: null,      // { name, provider, createdAt }
    editingId: null,
    confirmId: null,
    lastLoginBody: null,   // 확인용: 방금 보낸 로그인 확인 요청 (재사용하면 거절돼야 한다)
    loggedOutToken: null,  // 확인용: 로그아웃한 토큰 (다시 쓰면 거절돼야 한다)
  };

  // -------------------------------------------------------------------------
  // 작은 DOM 도우미
  // -------------------------------------------------------------------------

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  };

  // -------------------------------------------------------------------------
  // 모달 틀
  // -------------------------------------------------------------------------

  const modal = el('div', {
    class: 'mm-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'MY MEMO',
    onclick: (e) => { if (e.target === modal) close(); },
  });
  const panel = el('div', { class: 'mm-panel' });
  const inner = el('div', { class: 'mm-inner' });
  panel.append(el('div', { class: 'mm-band', 'aria-hidden': 'true' }), inner);
  modal.append(panel);
  document.body.append(modal);

  let lastFocus = null;

  function open(view) {
    lastFocus = document.activeElement;
    state.view = view;
    render();
    modal.classList.add('active');
    document.body.classList.add('modal-open');
    const first = inner.querySelector('input, button.mm-btn');
    if (first) setTimeout(() => first.focus(), 50);
  }

  function close() {
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');
    state.editingId = null;
    state.confirmId = null;
    // 주소로 연 화면이면 주소의 #setup / #evidence 를 지운다
    if (/^#(setup|evidence)$/.test(location.hash)) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (lastFocus) lastFocus.focus();
  }

  function topButtons({ logout = false } = {}) {
    return el('div', { class: 'mm-top' },
      logout && el('button', { type: 'button', class: 'mm-logout', text: 'LOGOUT', onclick: logoutClicked }),
      el('button', { type: 'button', class: 'mm-close', 'aria-label': '닫기', text: '×', onclick: close }),
    );
  }

  function message(text = '', kind = '') {
    return el('div', { class: `mm-msg ${kind}`, role: 'status', 'aria-live': 'polite', text });
  }

  function setMessage(text, kind = '') {
    const box = inner.querySelector('.mm-msg');
    if (!box) return;
    box.className = `mm-msg ${kind}`;
    box.textContent = text;
  }

  // -------------------------------------------------------------------------
  // 화면: 로그인 전
  // -------------------------------------------------------------------------

  function viewLogin(notice) {
    const supported = !!window.PublicKeyCredential;
    const account = el('input', {
      class: 'mm-input',
      id: 'mm-account',
      type: 'text',
      placeholder: '계정 이름',
      autocomplete: 'username webauthn',
      autocapitalize: 'none',
      spellcheck: 'false',
      onkeydown: (e) => { if (e.key === 'Enter') loginClicked(); },
    });
    return [
      topButtons(),
      el('div', { class: 'mm-label', text: 'PRIVATE 🔒' }),
      el('h2', { class: 'mm-title', text: 'MY MEMO' }),
      el('p', { class: 'mm-sub', text: '패스키로만 열리는 나만의 자리입니다. 비밀번호는 없습니다.' }),
      supported
        ? [
          el('div', { class: 'mm-field' },
            el('label', { for: 'mm-account', text: 'ACCOUNT' }),
            account),
          el('button', { type: 'button', class: 'mm-btn', id: 'mm-login', text: '🔑 패스키로 로그인', onclick: loginClicked }),
        ]
        : null,
      message(
        supported ? (notice?.text ?? '') : '이 브라우저는 패스키를 지원하지 않습니다. 최신 Chrome, Edge, Safari에서 열어 주세요.',
        supported ? (notice?.kind ?? '') : 'warn',
      ),
      el('p', { class: 'mm-note', text: '로그인하기 전에는 메모 내용을 서버에서 받아 오지 않습니다.' }),
    ];
  }

  // -------------------------------------------------------------------------
  // 화면: 로그인 후 메모
  // -------------------------------------------------------------------------

  function memoRow(memo) {
    if (state.editingId === memo.id) {
      const input = el('input', {
        class: 'mm-input',
        type: 'text',
        maxlength: '200',
        value: memo.body,
        'aria-label': '메모 수정',
        onkeydown: (e) => {
          if (e.key === 'Enter') saveEdit(memo.id, input.value);
          if (e.key === 'Escape') { e.stopPropagation(); state.editingId = null; render(); }
        },
      });
      setTimeout(() => input.focus(), 0);
      return el('li', { class: 'mm-row editing' },
        input,
        el('button', { type: 'button', class: 'mm-link', text: '저장', onclick: () => saveEdit(memo.id, input.value) }),
        el('button', { type: 'button', class: 'mm-link', text: '취소', onclick: () => { state.editingId = null; render(); } }),
      );
    }
    if (state.confirmId === memo.id) {
      return el('li', { class: 'mm-row confirm' },
        el('span', { class: 'mm-row-text', text: '이 메모를 지울까요?' }),
        el('button', { type: 'button', class: 'mm-link warn', text: '삭제', onclick: () => deleteMemo(memo.id) }),
        el('button', { type: 'button', class: 'mm-link', text: '취소', onclick: () => { state.confirmId = null; render(); } }),
      );
    }
    return el('li', { class: 'mm-row' },
      el('span', { class: 'mm-row-text', text: memo.body }),
      el('button', { type: 'button', class: 'mm-link', text: '수정', onclick: () => { state.editingId = memo.id; state.confirmId = null; render(); } }),
      el('button', { type: 'button', class: 'mm-link warn', text: '삭제', onclick: () => { state.confirmId = memo.id; state.editingId = null; render(); } }),
    );
  }

  function viewMemos() {
    const input = el('input', {
      class: 'mm-input',
      id: 'mm-new',
      type: 'text',
      maxlength: '200',
      placeholder: '새 메모 한 줄…',
      'aria-label': '새 메모',
      onkeydown: (e) => { if (e.key === 'Enter') addMemo(input.value); },
    });
    const count = state.memos.length;
    return [
      topButtons({ logout: true }),
      el('div', { class: 'mm-label', text: 'PRIVATE 🔓' }),
      el('h2', { class: 'mm-title' }, 'MY MEMO', el('span', { class: 'mm-pill', text: state.username ?? '' })),
      el('div', { class: 'mm-add' },
        input,
        el('button', { type: 'button', class: 'mm-btn', text: '추가', onclick: () => addMemo(input.value) })),
      message(),
      count
        ? el('ul', { class: 'mm-list' }, state.memos.map(memoRow))
        : el('p', { class: 'mm-empty', text: '아직 메모가 없습니다. 첫 줄을 적어 보세요.' }),
      el('p', { class: 'mm-note' },
        `${count}건 · 모두 과제용으로 만들어 넣은 예시입니다`,
        state.passkey && [
          el('br'),
          el('b', { text: '패스키 ' }),
          `${state.passkey.name} · ${state.passkey.provider} · ${fmtDate(state.passkey.createdAt)} 등록 · 서버에는 공개키만 저장`,
        ],
      ),
    ];
  }

  // -------------------------------------------------------------------------
  // 화면: #setup (첫 패스키 등록)
  // -------------------------------------------------------------------------

  function viewSetup() {
    return [
      topButtons(),
      el('div', { class: 'mm-label', text: 'PRIVATE · SETUP' }),
      el('h2', { class: 'mm-title' }, '패스키 등록', el('span', { class: 'mm-tag', text: '#setup' })),
      el('p', { class: 'mm-sub', text: '허용된 계정에 아직 패스키가 없을 때 한 번만 등록할 수 있습니다.' }),
      el('div', { class: 'mm-fields' },
        el('div', { class: 'mm-field' },
          el('label', { for: 'mm-setup-account', text: 'ACCOUNT' }),
          el('input', { class: 'mm-input', id: 'mm-setup-account', type: 'text', placeholder: '계정 이름', autocapitalize: 'none', spellcheck: 'false' })),
        el('div', { class: 'mm-field' },
          el('label', { for: 'mm-setup-name', text: 'PASSKEY NAME' }),
          el('input', { class: 'mm-input', id: 'mm-setup-name', type: 'text', maxlength: '40', placeholder: '예: 과제8 크롬' })),
      ),
      el('div', { class: 'mm-tools' },
        el('button', { type: 'button', class: 'mm-btn', id: 'mm-register', text: '🔑 패스키 등록', onclick: registerClicked }),
        el('button', { type: 'button', class: 'mm-btn ghost', text: '기록 복사', onclick: copyLog })),
      message(),
      el('div', { class: 'mm-log', id: 'mm-log', 'aria-label': '등록 요청·응답 기록', 'data-placeholder': '등록 요청과 응답이 여기에 기록됩니다.' }),
    ];
  }

  // -------------------------------------------------------------------------
  // 화면: #evidence (로그인 후 확인 도구)
  // -------------------------------------------------------------------------

  const EVIDENCE_TESTS = [
    ['no-login', '로그인 없이 요청'],
    ['replay', '이미 쓴 질문 재사용'],
    ['tamper', '서명 변조'],
    ['old-token', '로그아웃한 토큰'],
    ['other-account', '다른 계정 이름 넣기'],
  ];

  function viewEvidence() {
    return [
      topButtons({ logout: true }),
      el('div', { class: 'mm-label', text: 'PRIVATE · EVIDENCE' }),
      el('h2', { class: 'mm-title' }, '확인 기록', el('span', { class: 'mm-tag', text: '#evidence' })),
      el('p', { class: 'mm-sub', text: '막혀야 하는 요청을 일부러 보내고, 요청과 응답을 그대로 남깁니다. 세션 토큰은 가려서 표시합니다.' }),
      el('div', { class: 'mm-tools' },
        EVIDENCE_TESTS.map(([id, label]) =>
          el('button', { type: 'button', class: 'mm-btn ghost small', 'data-test': id, text: label, onclick: () => evidenceClicked(id) })),
        el('button', { type: 'button', class: 'mm-btn ghost small', text: '기록 복사', onclick: copyLog }),
      ),
      message(),
      el('div', { class: 'mm-log', id: 'mm-log', 'aria-label': '요청·응답 기록', 'data-placeholder': '위 버튼을 누르면 요청과 응답이 여기에 기록됩니다. (토큰은 가려서 표시)' }),
    ];
  }

  // -------------------------------------------------------------------------
  // 그리기
  // -------------------------------------------------------------------------

  function render(notice) {
    const views = { login: viewLogin, memos: viewMemos, setup: viewSetup, evidence: viewEvidence };
    inner.replaceChildren(...[views[state.view](notice)].flat(3).filter(Boolean));
    renderLog();
  }

  // -------------------------------------------------------------------------
  // 요청·응답 기록 (#setup, #evidence 화면에 보인다. 세션 토큰은 가린다 — T08-C34)
  // -------------------------------------------------------------------------

  const logEntries = [];

  const maskToken = (v) => (typeof v === 'string' && v.length > 8 ? `${v.slice(0, 6)}…(가림)` : v);

  function maskDeep(data) {
    if (Array.isArray(data)) return data.map(maskDeep);
    if (data && typeof data === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(data)) out[k] = k === 'token' ? maskToken(v) : maskDeep(v);
      return out;
    }
    return data;
  }

  function log(text, cls) {
    logEntries.push({ text, cls });
    renderLog();
  }

  const logNote = (text) => log(`# ${new Date().toLocaleTimeString('ko-KR')} ${text}`, 'note');

  function renderLog() {
    const box = inner.querySelector('#mm-log');
    if (!box) return;
    box.replaceChildren(...logEntries.map((e) => el('div', { class: e.cls, text: e.text })));
    box.scrollTop = box.scrollHeight;
  }

  // -------------------------------------------------------------------------
  // 서버 요청
  // -------------------------------------------------------------------------

  async function api(method, path, body, { bearer } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    log(
      `→ ${method} ${path}` +
        (bearer ? `\n  Authorization: Bearer ${maskToken(bearer)}` : '') +
        (body !== undefined ? `\n  body: ${JSON.stringify(maskDeep(body), null, 2)}` : ''),
      'req',
    );

    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // 서버가 응답하지 않으면 20초 뒤 포기하고 안내한다
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      log(`← ${timedOut ? '응답 없음 (20초)' : `연결 실패: ${err.message}`}`, 'bad');
      return {
        status: 0,
        ok: false,
        data: { error: timedOut ? '서버가 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.' : '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' },
      };
    }
    let data = null;
    try { data = await res.json(); } catch { /* 본문 없음 */ }
    log(`← ${res.status}\n${JSON.stringify(maskDeep(data), null, 2)}`, res.ok ? 'ok' : 'bad');
    return { status: res.status, ok: res.ok, data };
  }

  const webauthn = () => window.SimpleWebAuthnBrowser;

  // 사용자가 패스키 창을 닫았거나 시간이 지나 취소된 경우
  const isCancel = (err) => err && (err.name === 'NotAllowedError' || err.name === 'AbortError');

  function busy(button, on) {
    if (button) button.disabled = on;
  }

  // -------------------------------------------------------------------------
  // 등록 (#setup)
  // -------------------------------------------------------------------------

  async function registerClicked(e) {
    const button = e?.currentTarget;
    const account = inner.querySelector('#mm-setup-account').value.trim().toLowerCase();
    const name = inner.querySelector('#mm-setup-name').value.trim();
    if (!account) return setMessage('계정 이름을 적어 주세요.', 'warn');
    if (!name) return setMessage('패스키 이름을 적어 주세요. 목록에서 알아볼 수 있는 이름이면 됩니다.', 'warn');

    busy(button, true);
    setMessage('패스키 창을 확인해 주세요…');
    logNote(`패스키 등록 시작 (${account})`);
    try {
      const opt = await api('POST', '/register/options', { username: account });
      if (!opt.ok) return setMessage(opt.data?.error ?? '등록을 시작하지 못했습니다.', 'warn');

      let attestation;
      try {
        attestation = await webauthn().startRegistration({ optionsJSON: opt.data.options });
      } catch (err) {
        // 등록을 그만두면 보관 중인 질문을 버리고, 서버에는 아무것도 저장하지 않는다 (T08-C25)
        await api('POST', '/register/cancel', { challengeId: opt.data.challengeId });
        if (isCancel(err)) {
          return setMessage('패스키 등록을 취소했습니다. 서버에는 아무것도 저장되지 않았습니다.');
        }
        if (err.name === 'InvalidStateError') {
          return setMessage('이 보관함에는 이미 이 계정의 패스키가 있습니다.', 'warn');
        }
        return setMessage(`패스키를 만들지 못했습니다: ${err.message}`, 'warn');
      }

      const ver = await api('POST', '/register/verify', {
        challengeId: opt.data.challengeId,
        name,
        response: attestation,
      });
      if (!ver.ok) return setMessage(ver.data?.error ?? '등록 확인에 실패했습니다.', 'warn');

      const s = ver.data.stored;
      setMessage(
        `패스키 "${s.name}" 등록 완료\n` +
          `저장된 곳: ${s.provider}\n` +
          `서버에 저장된 값(공개키): ${s.publicKey_COSE_base64url.slice(0, 32)}…\n` +
          '이제 🔒 MY MEMO에서 로그인하세요.',
        'ok',
      );
    } finally {
      busy(button, false);
    }
  }

  // -------------------------------------------------------------------------
  // 로그인 / 로그아웃
  // -------------------------------------------------------------------------

  async function loginClicked() {
    const button = inner.querySelector('#mm-login');
    const account = inner.querySelector('#mm-account').value.trim().toLowerCase();
    if (!account) return setMessage('계정 이름을 적어 주세요.', 'warn');

    busy(button, true);
    setMessage('패스키 창을 확인해 주세요…');
    logNote(`로그인 시작 (${account})`);
    try {
      const opt = await api('POST', '/login/options', { username: account });
      if (!opt.ok) {
        return setMessage(
          opt.status === 404 ? '이 계정에 등록된 패스키가 없습니다.' : (opt.data?.error ?? '로그인을 시작하지 못했습니다.'),
          'warn',
        );
      }

      let assertion;
      try {
        assertion = await webauthn().startAuthentication({ optionsJSON: opt.data.options });
      } catch (err) {
        if (isCancel(err)) return setMessage('로그인을 취소했습니다.');
        return setMessage(`패스키 확인에 실패했습니다: ${err.message}`, 'warn');
      }

      const body = { challengeId: opt.data.challengeId, response: assertion };
      state.lastLoginBody = body; // #evidence의 "이미 쓴 질문 재사용" 확인용
      const ver = await api('POST', '/login/verify', body);
      if (!ver.ok) return setMessage('패스키 확인에 실패했습니다. 다시 시도해 주세요.', 'warn');

      state.token = ver.data.token;
      state.username = ver.data.username;
      if (!(await loadPrivate())) return;
      state.view = location.hash === '#evidence' ? 'evidence' : 'memos';
      render();
    } finally {
      busy(button, false);
    }
  }

  // 로그인한 뒤에만 서버에서 받아 오는 것: 메모와 패스키 정보
  async function loadPrivate() {
    const [meRes, memosRes] = [await api('GET', '/me', undefined, { bearer: state.token }),
      await api('GET', '/memos', undefined, { bearer: state.token })];
    if (meRes.status === 401 || memosRes.status === 401) {
      sessionEnded();
      return false;
    }
    if (!meRes.ok || !memosRes.ok) {
      setMessage('메모를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 'warn');
      return false;
    }
    state.passkey = meRes.data.passkey;
    state.memos = memosRes.data.memos;
    return true;
  }

  function clearSession() {
    state.token = null;
    state.username = null;
    state.memos = [];
    state.passkey = null;
    state.editingId = null;
    state.confirmId = null;
  }

  // 세션이 끝났거나(1시간) 서버가 401을 돌려주면 로그인 화면으로 돌아간다
  function sessionEnded() {
    clearSession();
    state.view = 'login';
    render({ text: '로그인이 끝났습니다. 패스키로 다시 들어와 주세요.', kind: 'warn' });
  }

  async function logoutClicked() {
    if (state.token) {
      logNote('로그아웃');
      await api('POST', '/logout', {}, { bearer: state.token });
      state.loggedOutToken = state.token; // #evidence의 "로그아웃한 토큰" 확인용
    }
    clearSession();
    state.view = 'login';
    render({ text: '로그아웃했습니다.', kind: 'ok' });
  }

  // -------------------------------------------------------------------------
  // 다음 단계에서 서버와 연결할 동작
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 메모 추가·수정·삭제 (주인은 서버가 세션으로 정한다)
  // -------------------------------------------------------------------------

  function checkMemo(text) {
    const body = String(text ?? '').trim();
    if (!body) { setMessage('메모 내용을 적어 주세요.', 'warn'); return null; }
    if (body.length > 200) { setMessage('메모는 200자까지 적을 수 있습니다.', 'warn'); return null; }
    return body;
  }

  // 요청 결과가 401이면 로그인 화면으로 돌아간다
  function handleFail(res, fallback) {
    if (res.status === 401) { sessionEnded(); return; }
    setMessage(res.data?.error ?? fallback, 'warn');
  }

  async function addMemo(text) {
    const body = checkMemo(text);
    if (body === null) return;
    const res = await api('POST', '/memos', { body }, { bearer: state.token });
    if (!res.ok) return handleFail(res, '메모를 저장하지 못했습니다.');
    state.memos.push(res.data.memo);
    render();
    inner.querySelector('#mm-new')?.focus();
  }

  async function saveEdit(id, text) {
    const body = checkMemo(text);
    if (body === null) return;
    const res = await api('PATCH', `/memos/${id}`, { body }, { bearer: state.token });
    if (!res.ok) return handleFail(res, '메모를 고치지 못했습니다.');
    state.memos = state.memos.map((m) => (m.id === id ? res.data.memo : m));
    state.editingId = null;
    render();
  }

  async function deleteMemo(id) {
    const res = await api('DELETE', `/memos/${id}`, undefined, { bearer: state.token });
    if (!res.ok) return handleFail(res, '메모를 지우지 못했습니다.');
    state.memos = state.memos.filter((m) => m.id !== id);
    state.confirmId = null;
    render();
  }

  // -------------------------------------------------------------------------
  // #evidence: 막혀야 하는 요청을 일부러 보내 본다 (요청·응답은 기록 창에 남는다)
  // -------------------------------------------------------------------------

  // base64url 문자열의 가운데 한 바이트를 바꾼다 (서명 변조 확인용)
  function flipByte(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const EVIDENCE = {
    // 로그인 없이 비공개 자료 요청 → 401 (T08-C16, C17)
    async 'no-login'() {
      logNote('확인: 세션 토큰 없이 메모 요청');
      await api('GET', '/memos');
    },

    // 방금 로그인할 때 보낸 요청을 그대로 다시 보냄 → 401 (T08-C31)
    async replay() {
      logNote('확인: 이미 한 번 쓴 질문(challenge)과 서명으로 다시 로그인');
      if (!state.lastLoginBody) {
        return setMessage('이 탭에서 로그인한 기록이 없습니다. 새로고침 없이 로그인한 직후에 눌러 주세요.', 'warn');
      }
      await api('POST', '/login/verify', state.lastLoginBody);
    },

    // 새 로그인 절차를 밟되 서명을 한 바이트 바꿔 보냄 → 401 (T08-C30)
    async tamper() {
      logNote(`확인: 서명을 한 바이트 바꿔 로그인 (${state.username})`);
      const opt = await api('POST', '/login/options', { username: state.username });
      if (!opt.ok) return;
      setMessage('패스키 창에서 확인해 주세요. 서명을 받은 뒤 일부러 망가뜨려 보냅니다.');
      let assertion;
      try {
        assertion = await webauthn().startAuthentication({ optionsJSON: opt.data.options });
      } catch (err) {
        return setMessage(isCancel(err) ? '확인을 취소했습니다.' : `패스키 오류: ${err.message}`, 'warn');
      }
      assertion.response.signature = flipByte(assertion.response.signature);
      const res = await api('POST', '/login/verify', { challengeId: opt.data.challengeId, response: assertion });
      setMessage(res.status === 401 ? '변조된 서명은 거절되었습니다 (401).' : `예상과 다른 응답: ${res.status}`, res.status === 401 ? 'ok' : 'warn');
    },

    // 로그아웃한 뒤 같은 토큰으로 다시 요청 → 401 (T08-C33)
    async 'old-token'() {
      logNote('확인: 로그아웃한 세션 토큰으로 메모 요청');
      const old = state.token;
      await api('POST', '/logout', {}, { bearer: old });
      state.loggedOutToken = old;
      await api('GET', '/memos', undefined, { bearer: old });
      clearSession();
      setMessage('로그아웃되었습니다. 같은 토큰은 거절됩니다 (401). 다른 확인을 하려면 다시 로그인하세요.', 'ok');
      inner.querySelectorAll('[data-test]').forEach((b) => { if (b.dataset.test !== 'no-login') b.disabled = true; });
    },

    // 주소와 본문에 다른 계정 이름을 넣어도 내 자료만 온다 (T08-C40)
    async 'other-account'() {
      logNote('확인: 주소와 본문에 다른 계정(someone)을 적어 요청');
      await api('GET', '/memos?user=someone&username=someone', undefined, { bearer: state.token });
      const res = await api('POST', '/memos', {
        body: '(확인용) someone 계정에 쓰려고 한 메모',
        username: 'someone',
        user_id: 999999,
      }, { bearer: state.token });
      if (res.ok) {
        logNote('확인용 메모는 내 계정(dh)에 저장되었으므로 바로 지웁니다');
        await api('DELETE', `/memos/${res.data.memo.id}`, undefined, { bearer: state.token });
      }
    },
  };

  async function evidenceClicked(id) {
    if (!state.token && id !== 'no-login') {
      return setMessage('로그인이 필요한 확인입니다. 다시 로그인해 주세요.', 'warn');
    }
    const buttons = inner.querySelectorAll('[data-test]');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await EVIDENCE[id]();
    } finally {
      buttons.forEach((b) => { b.disabled = !state.token && b.dataset.test !== 'no-login'; });
    }
  }

  async function copyLog() {
    const text = logEntries.map((e) => e.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setMessage('기록을 클립보드에 복사했습니다.', 'ok');
    } catch {
      setMessage('복사하지 못했습니다. 기록을 직접 선택해서 복사해 주세요.', 'warn');
    }
  }

  // -------------------------------------------------------------------------
  // 여는 길: 사이드바 버튼, 주소 #setup / #evidence, Esc로 닫기
  // -------------------------------------------------------------------------

  function openFromHash() {
    if (location.hash === '#setup') open('setup');
    else if (location.hash === '#evidence') {
      // 확인 도구는 로그인한 사람에게만 보인다 (보안은 서버가 따로 막는다)
      if (state.token) open('evidence');
      else {
        open('login');
        setMessage('확인 기록은 패스키로 로그인한 뒤에 열 수 있습니다.');
      }
    }
  }

  document.querySelectorAll('[data-my-memo-open]').forEach((btn) =>
    btn.addEventListener('click', () => open(state.token ? 'memos' : 'login')));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) close();
  });

  window.addEventListener('hashchange', openFromHash);
  openFromHash();

  // API 주소가 없으면 개발자에게 알린다
  if (!API) console.warn('MY MEMO: config.js 의 MY_MEMO_API 가 비어 있습니다.');
})();
