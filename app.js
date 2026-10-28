'use strict';

/* ================= 유틸 ================= */
const $app = document.getElementById('app');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rand = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pressed = (b) => `aria-pressed="${b}"`;

/* ================= 설정·상태 ================= */
const MODES = {
  normal: { name: '노말', desc: '라이어는 자신이 라이어인 걸 알고, 제시어 없이 주제만 보고 시작해요.' },
  fool: { name: '바보', desc: '라이어는 자기가 라이어인 줄 몰라요. 비슷하지만 다른 단어를 받아요.' },
  spy: { name: '스파이', desc: '제시어와 라이어를 아는 스파이가 시민인 척 라이어를 도와요. (5명 이상)' },
};
const TIMERS = [0, 60, 120, 180, 300, 420];
const MIN_P = 3, MAX_P = 15;
const CUSTOM = '직접 입력';
const DEFAULTS = { players: 5, names: [], mode: 'normal', liars: 1, cats: [], showCat: true, timer: 180, vote: 'point', custom: '' };

let settings = { ...DEFAULTS, ...store.get('liar.settings', {}) };
let scores = store.get('liar.scores', {});
const used = new Set();
let round = null;
let screen = 'home';
let ui = {};
let timerId = null;
let wakeLock = null;

const saveSettings = () => store.set('liar.settings', settings);

function normalize() {
  const s = settings;
  s.players = Math.min(MAX_P, Math.max(MIN_P, s.players | 0));
  if (s.mode === 'spy' && s.players < 5) s.mode = 'normal';
  if (s.liars === 2 && s.players < (s.mode === 'spy' ? 7 : 6)) s.liars = 1;
  if (!TIMERS.includes(s.timer)) s.timer = 180;
  s.cats = s.cats.filter((c) => allCats().some((x) => x.name === c));
}

function playerNames() {
  const seen = {};
  return Array.from({ length: settings.players }, (_, i) => {
    let n = (settings.names[i] || '').trim().slice(0, 12) || `플레이어 ${i + 1}`;
    if (seen[n]) n = `${n} ${++seen[n]}`; else seen[n] = 1;
    return n;
  });
}

function parseCustom(text) {
  return text.split('\n')
    .map((l) => l.split(/[\/,]/).map((w) => w.trim()).filter(Boolean).slice(0, 2))
    .filter((p) => p.length);
}

function allCats() {
  const cats = [...window.WORDS];
  const custom = parseCustom(settings.custom || '');
  if (custom.length) cats.push({ name: CUSTOM, emoji: '✏️', pairs: custom });
  return cats;
}

function activeCats() {
  const all = allCats();
  return settings.cats.length ? all.filter((c) => settings.cats.includes(c.name)) : all.filter((c) => c.name !== CUSTOM);
}

function pickWord() {
  const pool = [];
  for (const c of activeCats()) for (const p of c.pairs) pool.push({ cat: c.name, pair: p });
  let avail = pool.filter((x) => !used.has(x.cat + '|' + x.pair.join('|')));
  if (!avail.length) { for (const x of pool) used.delete(x.cat + '|' + x.pair.join('|')); avail = pool; }
  const x = avail[rand(avail.length)];
  used.add(x.cat + '|' + x.pair.join('|'));
  let [word, decoy] = x.pair.length === 2 && rand(2) ? [x.pair[1], x.pair[0]] : x.pair;
  if (!decoy) {
    // 단어 하나만 적은 직접 입력: 같은 카테고리의 다른 단어를 바보 모드용으로 빌린다
    const others = pool.filter((y) => y.cat === x.cat && y.pair[0] !== word).map((y) => y.pair[0]);
    decoy = others.length ? others[rand(others.length)] : '???';
  }
  return { cat: x.cat, word, decoy };
}

/* ================= 라운드 ================= */
function startRound() {
  normalize();
  saveSettings();
  const names = playerNames();
  const n = names.length;
  const order = shuffle([...Array(n).keys()]);
  const liars = order.slice(0, settings.liars);
  const spy = settings.mode === 'spy' ? order[settings.liars] : null;
  round = {
    ...pickWord(), names, liars, spy,
    mode: settings.mode, showCat: settings.showCat,
    step: 0, first: rand(n), dir: rand(2) ? '시계 방향' : '반시계 방향',
    tie: 0, candidates: [...Array(n).keys()], ballots: [], voter: 0, accused: null,
  };
  requestWake();
  go('reveal');
}

const roleOf = (i) => (round.liars.includes(i) ? 'liar' : i === round.spy ? 'spy' : 'citizen');
const liarTeam = (i) => roleOf(i) !== 'citizen';

function finish(type) {
  const gains = {};
  const pts = { citizen: 1, miss: 3, tie: 3, guess: 2 }[type];
  round.names.forEach((nm, i) => {
    if ((type === 'citizen') !== liarTeam(i)) gains[nm] = pts;
  });
  for (const nm of round.names) scores[nm] = (scores[nm] || 0) + (gains[nm] || 0);
  store.set('liar.scores', scores);
  round.result = { type, gains };
  releaseWake();
  go('result');
}

/* ================= 화면 전환 ================= */
const IN_GAME = ['reveal', 'discuss', 'vote', 'secret', 'tally', 'accuse'];

function go(next, keepUi) {
  clearInterval(timerId); timerId = null;
  if (!keepUi) ui = {};
  if (screen === 'home' && next !== 'home') history.pushState({ app: 1 }, '');
  screen = next;
  render();
  if (!keepUi) window.scrollTo(0, 0);
}

function render() {
  $app.innerHTML = VIEWS[screen]();
  if (screen === 'discuss') tickTimer();
}

const topbar = (title, left = 'back', right = '') => `
  <header class="topbar">
    <div class="side">${left === 'back' ? '<button class="icon-btn" data-act="back" aria-label="뒤로">‹</button>'
      : left === 'exit' ? '<button class="icon-btn" data-act="exit" aria-label="게임 나가기">✕</button>' : ''}</div>
    <h2>${title}</h2>
    <div class="side">${right}</div>
  </header>`;

const progressDots = (total, now) => `<div class="progress" aria-label="${now + 1} / ${total}">${
  Array.from({ length: total }, (_, i) => `<i class="${i < now ? 'done' : i === now ? 'now' : ''}"></i>`).join('')}</div>`;

const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/* ================= 화면들 ================= */
const VIEWS = {
  home: () => `
    <section class="screen center">
      <p class="home-en">Liar Game</p>
      <h1 class="home-title">라이어 게임<span class="q">?</span></h1>
      <p class="home-sub">폰 하나로 둘러앉아 하는 라이어 게임</p>
      <div class="home-actions">
        <button class="btn primary" data-act="to" data-arg="setup">게임 시작</button>
        <button class="btn link" style="width:100%" data-act="to" data-arg="howto">플레이 방법</button>
      </div>
      <p class="home-meta">3–15명 · 오프라인 · 제시어 ${window.WORDS.reduce((a, c) => a + c.pairs.length, 0)}쌍</p>
    </section>`,

  howto: () => `
    ${topbar('플레이 방법')}
    <section class="screen prose">
      <h3>1. 준비</h3>
      <ol>
        <li>인원·모드·주제를 고르고 <b>시작하기</b>를 누르세요.</li>
        <li>화면에 이름이 뜬 사람이 폰을 받아 <b>카드를 탭</b>해 자신의 제시어를 확인해요.</li>
        <li><b>확인했어요</b>를 누르면 카드가 가려져요. 다음 사람에게 넘기세요.</li>
      </ol>
      <h3>2. 설명</h3>
      <ol>
        <li>첫 사람부터 돌아가며 제시어를 <b>한 마디씩</b> 설명해요. 제시어를 그대로 말하면 안 돼요.</li>
        <li>라이어는 들키지 않게 아는 척, 시민은 라이어에게 정답을 들키지 않게 애매하게!</li>
        <li>타이머가 끝나거나 충분히 얘기했다면 투표로 넘어가요.</li>
      </ol>
      <h3>3. 투표</h3>
      <ul>
        <li><b>동시 지목</b>: “하나, 둘, 셋!”에 다 같이 손가락으로 가리키고, 가장 많이 지목된 사람을 앱에서 골라요.</li>
        <li><b>비밀 투표</b>: 폰을 돌려가며 한 명씩 몰래 투표해요.</li>
        <li>동점이면 동점자끼리 한 번 더 투표해요. <b>또 동점이면 라이어 팀 승리.</b></li>
      </ul>
      <h3>4. 결과</h3>
      <ul>
        <li>지목된 사람이 시민(또는 스파이)이면 <b>라이어 팀 승리</b>.</li>
        <li>라이어가 지목되면 <b>마지막 기회</b>! 라이어가 제시어를 맞히면 역전승, 틀리면 시민 승리.</li>
      </ul>
      <h3>모드</h3>
      ${Object.values(MODES).map((m) => `<div class="mode-card"><b>${m.name}</b>${m.desc}</div>`).join('')}
      <p class="muted" style="font-size:14px;margin-top:10px">라이어 2명은 6명 이상(스파이 모드는 7명 이상)일 때 고를 수 있어요.</p>
      <h3>점수</h3>
      <table class="pts">
        <tr><td>시민 승리 — 시민 각자</td><td>+1</td></tr>
        <tr><td>엉뚱한 사람 지목·재투표 동점 — 라이어 팀 각자</td><td>+3</td></tr>
        <tr><td>라이어가 제시어 맞히기 성공 — 라이어 팀 각자</td><td>+2</td></tr>
      </table>
      <div class="actions"><button class="btn primary" data-act="to" data-arg="setup">게임 시작</button></div>
    </section>`,

  setup: () => {
    normalize();
    const s = settings;
    const names = Array.from({ length: s.players }, (_, i) => `
      <input class="input" maxlength="12" placeholder="플레이어 ${i + 1}" value="${esc(s.names[i] || '')}" data-name="${i}" aria-label="${i + 1}번 이름">`).join('');
    const liarMin = s.mode === 'spy' ? 7 : 6;
    const citizens = s.players - s.liars - (s.mode === 'spy' ? 1 : 0);
    return `
    ${topbar('게임 설정')}
    <section class="screen">
      <div class="section">
        <div class="section-head"><h3 class="section-title">인원</h3>
          <span class="section-note">시민 ${citizens} · 라이어 ${s.liars}${s.mode === 'spy' ? ' · 스파이 1' : ''}</span></div>
        <div class="stepper">
          <button data-act="players" data-arg="-1" ${s.players <= MIN_P ? 'disabled' : ''} aria-label="한 명 빼기">−</button>
          <span class="val">${s.players}<small>명</small></span>
          <button data-act="players" data-arg="1" ${s.players >= MAX_P ? 'disabled' : ''} aria-label="한 명 더하기">+</button>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3 class="section-title">모드</h3></div>
        <div class="seg">${Object.entries(MODES).map(([k, m]) =>
          `<button data-act="mode" data-arg="${k}" ${pressed(s.mode === k)} ${k === 'spy' && s.players < 5 ? 'disabled' : ''}>${m.name}</button>`).join('')}</div>
        <p class="hint">${MODES[s.mode].desc}</p>
      </div>

      <div class="section">
        <div class="section-head"><h3 class="section-title">라이어 수</h3>
          ${s.players < liarMin ? `<span class="section-note">2명은 ${liarMin}명부터</span>` : ''}</div>
        <div class="seg">
          <button data-act="liars" data-arg="1" ${pressed(s.liars === 1)}>1명</button>
          <button data-act="liars" data-arg="2" ${pressed(s.liars === 2)} ${s.players < liarMin ? 'disabled' : ''}>2명</button>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3 class="section-title">주제</h3>
          <span class="section-note">${s.cats.length ? `${s.cats.length}개 선택` : '전체에서 무작위'}</span></div>
        <div class="chips" id="chips">${chipsHtml()}</div>
      </div>

      <div class="section">
        <div class="toggle-row">
          <div><div class="t">주제 공개</div><div class="d">끄면 라이어도 시민도 주제를 몰라요. 더 어려워져요.</div></div>
          <button class="switch" role="switch" aria-checked="${s.showCat}" aria-label="주제 공개" data-act="showCat"></button>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h3 class="section-title">설명 시간</h3></div>
        <div class="seg">${TIMERS.map((t) => `<button data-act="timer" data-arg="${t}" ${pressed(s.timer === t)}>${t ? `${t / 60}분` : '없음'}</button>`).join('')}</div>
      </div>

      <div class="section">
        <div class="section-head"><h3 class="section-title">투표 방식</h3></div>
        <div class="seg">
          <button data-act="vote" data-arg="point" ${pressed(s.vote === 'point')}>동시 지목</button>
          <button data-act="vote" data-arg="secret" ${pressed(s.vote === 'secret')}>비밀 투표</button>
        </div>
        <p class="hint">${s.vote === 'point' ? '“하나, 둘, 셋!”에 다 같이 가리키고 결과만 입력해요.' : '폰을 돌려가며 한 명씩 몰래 투표해요.'}</p>
      </div>

      <div class="section">
        <details ${ui.namesOpen ? 'open' : ''} data-details="namesOpen">
          <summary>참가자 이름 <span class="section-note" style="margin-left:auto;margin-right:8px">선택</span></summary>
          <div class="names">${names}</div>
        </details>
      </div>

      <div class="section">
        <details ${ui.customOpen ? 'open' : ''} data-details="customOpen">
          <summary>직접 만든 제시어 <span class="section-note" style="margin-left:auto;margin-right:8px">${parseCustom(s.custom).length ? `${parseCustom(s.custom).length}쌍` : '선택'}</span></summary>
          <textarea data-custom placeholder="한 줄에 하나씩, 시민 단어 / 라이어 단어&#10;예) 아메리카노 / 카페라떼&#10;예) 우리 담임쌤 / 옆반 담임쌤">${esc(s.custom)}</textarea>
          <p class="hint">입력하면 주제에 ‘✏️ ${CUSTOM}’가 생겨요. 이 기기에만 저장돼요.</p>
        </details>
      </div>

      <div class="sticky-actions">
        <button class="btn primary" data-act="start">시작하기</button>
      </div>
    </section>`;
  },

  reveal: () => {
    const r = round;
    const i = r.step;
    const n = r.names.length;
    const shown = !!ui.shown;
    const last = i === n - 1;
    return `
    ${topbar('제시어 확인', 'exit', `<span class="section-note">${i + 1}/${n}</span>`)}
    <section class="screen">
      ${progressDots(n, i)}
      <p class="who">${esc(r.names[i])}</p>
      <p class="who-sub">${shown ? '확인했으면 화면을 가리고 눌러주세요' : '다른 사람이 보지 않게 폰을 받으세요'}</p>
      <button class="flip ${shown ? 'on' : ''}" data-act="flip" aria-label="${shown ? '카드 내용' : '탭해서 카드 확인'}">
        <div class="inner">
          <div class="face front"><div class="mark">?</div><div class="tap">탭해서 확인하기</div></div>
          ${shown ? cardBack(i) : '<div class="face back"></div>'}
        </div>
      </button>
      <div class="grow"></div>
      <div class="sticky-actions">
        <button class="btn primary" data-act="next-reveal" ${shown ? '' : 'disabled'}>${last ? '모두 확인 완료 · 설명 시작' : '확인했어요 · 다음 사람에게'}</button>
      </div>
    </section>`;
  },

  discuss: () => {
    const r = round;
    if (ui.left == null) ui.left = settings.timer;
    return `
    ${topbar('설명 · 토론', 'exit')}
    <section class="screen">
      <div class="topic">
        <div class="label">주제</div>
        <div class="val">${r.showCat ? esc(catLabel(r.cat)) : '비공개'}</div>
      </div>
      ${settings.timer ? `
      <div class="timer" id="timer">
        <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="46"/><circle class="bar" cx="50" cy="50" r="46" stroke-dasharray="289.03" stroke-dashoffset="0"/></svg>
        <div class="num" id="timer-num">${fmt(ui.left)}</div>
      </div>
      <div class="timer-ctrl">
        <button class="btn small" data-act="timer-toggle" id="timer-btn">${ui.running ? '일시정지' : ui.left < settings.timer ? '계속' : '타이머 시작'}</button>
        <button class="btn small" data-act="timer-add">+30초</button>
        <button class="btn small" data-act="timer-reset" aria-label="타이머 처음으로">↺</button>
      </div>` : ''}
      <div class="callout"><b>${esc(r.names[r.first])}</b>부터 <b>${r.dir}</b>으로 한 마디씩 설명하세요.</div>
      <ul class="rules">
        <li>제시어를 그대로 말하면 안 돼요.</li>
        <li>너무 쉬우면 라이어가 정답을 알아채요.</li>
        <li>한 바퀴 이상 돌아도 괜찮아요. 서로 질문해도 돼요.</li>
      </ul>
      <div class="grow"></div>
      <div class="sticky-actions">
        <button class="btn primary" data-act="to-vote">투표하기</button>
      </div>
    </section>`;
  },

  vote: () => {
    const r = round;
    return `
    ${topbar(r.tie ? '재투표' : '투표', 'exit')}
    <section class="screen">
      <p class="lead">${r.tie ? '동점자 중에서 다시 지목!' : '하나, 둘, 셋!'}</p>
      <p class="sub">${r.tie ? '동점자만 후보로, 모두 다시 동시에 가리키세요.' : '다 같이 라이어라고 생각하는 사람을 동시에 가리키세요.'}<br>가장 많이 지목된 사람을 고르세요.</p>
      <div class="pick">${r.names.map((nm, i) => `<button data-act="sel" data-arg="${i}" ${pressed(ui.sel === i)}>${esc(nm)}</button>`).join('')}</div>
      <div class="grow"></div>
      <div class="sticky-actions">
        <button class="btn danger" data-act="accuse" ${ui.sel == null ? 'disabled' : ''}>${ui.sel == null ? '지목된 사람을 고르세요' : `${esc(r.names[ui.sel])} 지목`}</button>
        <button class="btn ghost" data-act="point-tie">${r.tie ? '또 동점이에요 (라이어 팀 승리)' : '동점이에요'}</button>
      </div>
    </section>`;
  },

  secret: () => {
    const r = round;
    const v = r.voter;
    const n = r.names.length;
    if (!ui.open) {
      return `
      ${topbar(r.tie ? '재투표' : '비밀 투표', 'exit', `<span class="section-note">${v + 1}/${n}</span>`)}
      <section class="screen center">
        ${progressDots(n, v)}
        <p class="who-sub" style="margin:24px 0 4px">${r.tie ? '동점자 중에서 다시 투표해요' : '다른 사람이 보지 않게 폰을 받으세요'}</p>
        <p class="big-name">${esc(r.names[v])}</p>
        <p class="sub">님의 투표 차례</p>
        <div style="width:100%;margin-top:24px"><button class="btn primary" data-act="open-ballot">투표하기</button></div>
      </section>`;
    }
    const cands = r.candidates.filter((c) => c !== v);
    return `
    ${topbar(r.tie ? '재투표' : '비밀 투표', 'exit', `<span class="section-note">${v + 1}/${n}</span>`)}
    <section class="screen">
      <p class="lead">${esc(r.names[v])}님, 누가 라이어 같나요?</p>
      <p class="sub">고른 뒤 확정하면 화면이 가려져요.</p>
      <div class="pick">${cands.map((i) => `<button data-act="sel" data-arg="${i}" ${pressed(ui.sel === i)}>${esc(r.names[i])}</button>`).join('')}</div>
      <div class="grow"></div>
      <div class="sticky-actions">
        <button class="btn danger" data-act="cast" ${ui.sel == null ? 'disabled' : ''}>투표 확정</button>
      </div>
    </section>`;
  },

  tally: () => {
    const r = round;
    const { counts, top } = countVotes();
    const max = Math.max(...counts);
    const tie = top.length > 1;
    const rows = r.candidates.map((i) => ({ i, c: counts[i] })).sort((a, b) => b.c - a.c);
    return `
    ${topbar('개표 결과', 'exit')}
    <section class="screen">
      <p class="lead">${tie ? (r.tie ? '또 동점이에요!' : '동점이에요!') : `${esc(r.names[top[0]])}님이 가장 많이 받았어요`}</p>
      <p class="sub">${tie ? (r.tie ? '재투표도 동점이라 라이어 팀이 이겨요.' : `${top.map((i) => esc(r.names[i])).join(', ')}님 중에서 다시 투표해요.`) : '정말 라이어일까요?'}</p>
      <div class="tally">${rows.map(({ i, c }) => `
        <div class="row ${c === max && c > 0 ? 'top' : ''}"><span class="name">${esc(r.names[i])}</span>
        <span class="bar"><i style="width:${max ? (c / max) * 100 : 0}%"></i></span><span class="cnt">${c}</span></div>`).join('')}</div>
      <div class="grow"></div>
      <div class="sticky-actions">
        ${tie
          ? (r.tie ? '<button class="btn primary" data-act="finish" data-arg="tie">결과 보기</button>'
            : '<button class="btn primary" data-act="revote">재투표 시작</button>')
          : `<button class="btn danger" data-act="accuse-top">${esc(r.names[top[0]])}님 정체 공개</button>`}
      </div>
    </section>`;
  },

  accuse: () => {
    const r = round;
    const i = r.accused;
    const role = roleOf(i);
    const stage = ui.stage || 'wait';
    let body = '';
    if (stage === 'wait') {
      body = `
        <p class="sub" style="margin:0">가장 많이 지목된 사람</p>
        <p class="big-name">${esc(r.names[i])}</p>
        <p class="sub">과연 라이어일까요?</p>`;
    } else if (role !== 'liar') {
      body = `
        <p class="big-name">${esc(r.names[i])}</p>
        <p class="verdict red pop">${role === 'spy' ? '스파이였어요!' : '시민이었어요!'}</p>
        <p class="sub">엉뚱한 사람을 지목했어요. 라이어 팀 승리!</p>`;
    } else {
      body = `
        <p class="big-name">${esc(r.names[i])}</p>
        <p class="verdict ok pop">라이어가 맞아요!</p>
        <p class="sub">${r.mode === 'fool' ? '자기가 라이어인 줄 몰랐겠죠? ' : ''}마지막 기회! 라이어는 시민의 제시어를 말해보세요.</p>
        ${stage === 'answer' ? `
          <div class="answer pop"><div class="label">시민 제시어</div><div class="word">${esc(r.word)}</div></div>
          <p class="sub" style="margin-top:12px">라이어가 맞혔나요?</p>` : ''}`;
    }
    let btns;
    if (stage === 'wait') btns = '<button class="btn danger" data-act="unmask">정체 공개</button>';
    else if (role !== 'liar') btns = '<button class="btn primary" data-act="finish" data-arg="miss">결과 보기</button>';
    else if (stage === 'caught') btns = '<button class="btn primary" data-act="show-answer">라이어가 답했어요 · 정답 공개</button>';
    else btns = `<div class="actions row" style="padding:0">
        <button class="btn" data-act="finish" data-arg="citizen">틀렸어요</button>
        <button class="btn danger" data-act="finish" data-arg="guess">맞혔어요</button></div>`;
    return `
    ${topbar('정체 공개', 'exit')}
    <section class="screen center">${body}</section>
    <div class="sticky-actions">${btns}</div>`;
  },

  result: () => {
    const r = round;
    const { type, gains } = r.result;
    const liarWin = type !== 'citizen';
    const reason = {
      citizen: '라이어를 잡았고, 제시어도 지켜냈어요.',
      miss: '엉뚱한 사람을 지목했어요.',
      tie: '재투표에서도 동점이 나왔어요.',
      guess: '잡혔지만 제시어를 맞혀 역전했어요!',
    }[type];
    const liarNames = r.liars.map((i) => esc(r.names[i])).join(', ');
    const board = [...r.names].sort((a, b) => (scores[b] || 0) - (scores[a] || 0));
    return `
    ${topbar('결과', 'none')}
    <section class="screen">
      <div class="banner ${liarWin ? 'liar' : 'citizen'} pop">
        <div class="t">${liarWin ? '라이어 팀 승리' : '시민 승리'}</div>
        <div class="d">${reason}</div>
      </div>
      <div class="summary">
        <div class="row"><span class="k">제시어</span><span class="v">${esc(r.word)}</span></div>
        ${r.mode === 'fool' ? `<div class="row"><span class="k">라이어 단어</span><span class="v">${esc(r.decoy)}</span></div>` : ''}
        <div class="row"><span class="k">주제</span><span class="v">${esc(catLabel(r.cat))}</span></div>
        <div class="row"><span class="k">라이어</span><span class="v">${liarNames}</span></div>
        ${r.spy != null ? `<div class="row"><span class="k">스파이</span><span class="v">${esc(r.names[r.spy])}</span></div>` : ''}
      </div>
      <div class="board">
        <h3>누적 점수 <button class="btn small ghost" data-act="reset-scores" style="min-height:32px">초기화</button></h3>
        ${board.map((nm, k) => {
          const i = r.names.indexOf(nm);
          const tag = roleOf(i) === 'liar' ? '<span class="tag">라이어</span>' : roleOf(i) === 'spy' ? '<span class="tag">스파이</span>' : '';
          return `<div class="row"><span class="rank">${k + 1}</span><span class="nm">${esc(nm)} ${tag}</span>
            ${gains[nm] ? `<span class="gain ${liarWin ? '' : 'ok'}">+${gains[nm]}</span>` : ''}<span class="pts">${scores[nm] || 0}</span></div>`;
        }).join('')}
      </div>
      <div class="grow"></div>
      <div class="sticky-actions">
        <button class="btn primary" data-act="start">다음 라운드</button>
        <div class="actions row" style="padding:0">
          <button class="btn" data-act="to" data-arg="setup">설정 바꾸기</button>
          <button class="btn" data-act="home">처음으로</button>
        </div>
      </div>
    </section>`;
  },
};

function chipsHtml() {
  const s = settings;
  return `<button class="chip" data-act="cat" data-arg="" ${pressed(!s.cats.length)}>🎲 전체</button>
    ${allCats().map((c) => `<button class="chip" data-act="cat" data-arg="${esc(c.name)}" ${pressed(s.cats.includes(c.name))}>${c.emoji} ${esc(c.name)}<span class="n">${c.pairs.length}</span></button>`).join('')}`;
}

function catLabel(name) {
  const c = allCats().find((x) => x.name === name);
  return c ? `${c.emoji} ${c.name}` : name;
}

function cardBack(i) {
  const r = round;
  const role = roleOf(i);
  const cat = r.showCat ? `<span class="cat">${esc(catLabel(r.cat))}</span>` : '';
  if (role === 'citizen' || (role === 'liar' && r.mode === 'fool')) {
    // 바보 모드 라이어 카드는 시민 카드와 똑같이 보여야 한다
    const w = role === 'liar' ? r.decoy : r.word;
    return `<div class="face back"><div class="label">제시어</div><div class="word">${esc(w)}</div>${cat}
      <div class="desc">라이어에게 들키지 않게 설명하세요.</div></div>`;
  }
  if (role === 'spy') {
    return `<div class="face back liar"><div class="label">당신은</div><div class="word red">스파이</div>
      <div class="label" style="margin-top:8px">제시어 <b style="color:var(--text)">${esc(r.word)}</b></div>${cat}
      <div class="desc">라이어는 <b style="color:var(--text)">${r.liars.map((k) => esc(r.names[k])).join(', ')}</b>.<br>시민인 척 라이어를 도와주세요. 라이어 팀이 이기면 당신도 승리!</div></div>`;
  }
  return `<div class="face back liar"><div class="label">당신은</div><div class="word red">라이어</div>${cat}
    <div class="desc">${r.showCat ? '다른 사람의 설명을 듣고 제시어를 추리하세요.' : '주제도 몰라요. 눈치껏 버텨보세요!'}<br>들키지 않게 아는 척하세요.</div></div>`;
}

function countVotes() {
  const counts = round.names.map(() => 0);
  for (const b of round.ballots) counts[b]++;
  const max = Math.max(...round.candidates.map((i) => counts[i]));
  return { counts, top: round.candidates.filter((i) => counts[i] === max) };
}

/* ================= 타이머 ================= */
function tickTimer() {
  if (!settings.timer) return;
  const el = document.getElementById('timer');
  if (!el) return;
  const num = document.getElementById('timer-num');
  const bar = el.querySelector('.bar');
  const total = Math.max(settings.timer, ui.total || 0);
  bar.style.strokeDashoffset = String(289.03 * (1 - ui.left / total));
  el.classList.toggle('low', ui.left <= 10 && ui.left > 0);
  el.classList.toggle('done', ui.left <= 0);
  num.textContent = ui.left <= 0 ? '시간 종료!' : fmt(ui.left);
}

function startTimer() {
  ui.running = true;
  ui.endAt = Date.now() + ui.left * 1000;
  clearInterval(timerId);
  timerId = setInterval(() => {
    const left = Math.max(0, Math.ceil((ui.endAt - Date.now()) / 1000));
    if (left !== ui.left) {
      ui.left = left;
      if (left > 0 && left <= 3) beep(660, 0.08);
      tickTimer();
    }
    if (left <= 0) {
      clearInterval(timerId); timerId = null; ui.running = false;
      beep(880, 0.5);
      try { navigator.vibrate?.([300, 120, 300]); } catch { /* 미지원 */ }
      const b = document.getElementById('timer-btn'); if (b) b.textContent = '계속';
    }
  }, 200);
}

let audioCtx = null;
function beep(freq, dur) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch { /* 오디오 미지원 */ }
}

/* ================= 화면 켜짐 유지 ================= */
async function requestWake() {
  try { if (!wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* 미지원 */ }
}
function releaseWake() { try { wakeLock?.release(); } catch { /* 무시 */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && IN_GAME.includes(screen)) { wakeLock = null; requestWake(); }
});

/* ================= 이벤트 ================= */
function confirmExit() {
  return !IN_GAME.includes(screen) || confirm('진행 중인 판을 끝내고 처음으로 돌아갈까요?\n(누적 점수는 남아요)');
}

const ACTIONS = {
  to: (a) => go(a),
  back: () => go(screen === 'setup' && round?.result ? 'result' : 'home'),
  home: () => { releaseWake(); round = null; go('home'); },
  exit: () => { if (confirmExit()) ACTIONS.home(); },
  players: (a) => { settings.players += +a; normalize(); saveSettings(); render(); },
  mode: (a) => { settings.mode = a; normalize(); saveSettings(); render(); },
  liars: (a) => { settings.liars = +a; normalize(); saveSettings(); render(); },
  cat: (a) => {
    if (!a) settings.cats = [];
    else settings.cats = settings.cats.includes(a) ? settings.cats.filter((c) => c !== a) : [...settings.cats, a];
    saveSettings(); render();
  },
  showCat: () => { settings.showCat = !settings.showCat; saveSettings(); render(); },
  timer: (a) => { settings.timer = +a; saveSettings(); render(); },
  vote: (a) => { settings.vote = a; saveSettings(); render(); },
  start: () => {
    if (screen === 'setup' && !activeCats().some((c) => c.pairs.length)) { alert('제시어가 있는 주제를 하나 이상 골라주세요.'); return; }
    startRound();
  },
  flip: () => {
    if (ui.shown) return;
    ui.shown = true;
    // 다시 그리면 뒤집히는 애니메이션이 안 보이므로 뒷면만 채우고 클래스를 붙인다
    const f = $app.querySelector('.flip');
    f.querySelector('.face.back').outerHTML = cardBack(round.step);
    $app.querySelector('.who-sub').textContent = '확인했으면 화면을 가리고 눌러주세요';
    $app.querySelector('[data-act="next-reveal"]').disabled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => f.classList.add('on')));
  },
  'next-reveal': () => {
    if (round.step < round.names.length - 1) { round.step++; go('reveal'); } else go('discuss');
  },
  'timer-toggle': (_, el) => {
    if (ui.running) {
      clearInterval(timerId); timerId = null; ui.running = false; el.textContent = '계속';
    } else {
      if (ui.left <= 0) { ui.left = 30; ui.total = settings.timer; }
      startTimer(); el.textContent = '일시정지';
    }
    tickTimer();
  },
  'timer-add': () => {
    ui.left += 30; ui.total = Math.max(settings.timer, ui.left, ui.total || 0);
    if (ui.running) ui.endAt += 30000;
    tickTimer();
  },
  'timer-reset': () => {
    clearInterval(timerId); timerId = null;
    ui = {}; render();
  },
  'to-vote': () => {
    round.tie = 0; round.ballots = []; round.voter = 0; round.candidates = round.names.map((_, i) => i);
    go(settings.vote === 'secret' ? 'secret' : 'vote');
  },
  sel: (a) => { ui.sel = +a; render(); },
  accuse: () => { round.accused = ui.sel; go('accuse'); },
  'point-tie': () => {
    if (round.tie) { finish('tie'); return; }
    round.tie = 1; go('vote');
  },
  'open-ballot': () => { ui.open = true; render(); },
  cast: () => {
    round.ballots.push(ui.sel);
    if (round.voter < round.names.length - 1) { round.voter++; go('secret'); } else go('tally');
  },
  revote: () => {
    round.candidates = countVotes().top;
    round.tie = 1; round.ballots = []; round.voter = 0;
    go('secret');
  },
  'accuse-top': () => { round.accused = countVotes().top[0]; go('accuse'); },
  unmask: () => { ui.stage = roleOf(round.accused) === 'liar' ? 'caught' : 'innocent'; render(); },
  'show-answer': () => { ui.stage = 'answer'; render(); },
  finish: (a) => finish(a),
  'reset-scores': () => {
    if (!confirm('누적 점수를 모두 0으로 되돌릴까요?')) return;
    scores = {}; store.set('liar.scores', scores); render();
  },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  ACTIONS[el.dataset.act]?.(el.dataset.arg, el);
});

$app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.name != null) {
    settings.names[+t.dataset.name] = t.value;
    saveSettings();
  } else if (t.hasAttribute('data-custom')) {
    settings.custom = t.value;
    saveSettings();
  }
});
// 직접 입력 제시어가 바뀌면 주제 칩만 다시 그린다 (전체를 다시 그리면 이어지는 탭이 사라진다)
$app.addEventListener('change', (e) => {
  if (!e.target.hasAttribute('data-custom')) return;
  normalize(); saveSettings();
  const chips = document.getElementById('chips');
  if (chips) chips.innerHTML = chipsHtml();
});
$app.addEventListener('toggle', (e) => {
  const d = e.target.dataset?.details;
  if (d) ui[d] = e.target.open;
}, true);

// 안드로이드 뒤로가기: 게임 중이면 확인을 받고, 아니면 이전 화면으로
window.addEventListener('popstate', () => {
  if (screen === 'home') return;
  if (!confirmExit()) { history.pushState({ app: 1 }, ''); return; }
  ACTIONS.home();
});
window.addEventListener('beforeunload', (e) => {
  if (IN_GAME.includes(screen)) { e.preventDefault(); e.returnValue = ''; }
});

normalize();
render();
