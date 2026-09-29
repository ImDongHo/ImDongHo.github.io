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
      el('button', { type: 'button', class: 'mm-btn', text: '🔑 패스키 등록', onclick: registerClicked }),
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
  }

  // -------------------------------------------------------------------------
  // 동작 (서버 연결은 다음 단계에서 붙인다)
  // -------------------------------------------------------------------------

  const NOT_YET = '서버 연결은 다음 단계에서 붙입니다. 지금은 화면만 준비되어 있습니다.';

  function loginClicked() { setMessage(NOT_YET); }
  function registerClicked() { setMessage(NOT_YET); }
  function evidenceClicked() { setMessage(NOT_YET); }
  function copyLog() { setMessage(NOT_YET); }
  function addMemo() { setMessage(NOT_YET); }
  function saveEdit() { setMessage(NOT_YET); }
  function deleteMemo() { setMessage(NOT_YET); }

  function logoutClicked() {
    state.token = null;
    state.username = null;
    state.memos = [];
    state.passkey = null;
    state.view = 'login';
    render({ text: '로그아웃했습니다.', kind: 'ok' });
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
