<!DOCTYPE html>
<html lang="en">
<head>
<script src="/js/config.js"></script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hassabe — Round 2</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;font-family:'Jost',sans-serif;-webkit-font-smoothing:antialiased;background:#FAF6EE;color:#2A1C06}

.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 0 80px}

/* ── TOP BAR ── */
.topbar{width:100%;background:#0C0902;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.topbar-logo{font-family:'Cormorant Garamond',serif;font-size:20px;color:#FAF0DC;text-decoration:none}
.topbar-logo span{color:#C9A84C}
.topbar-back{font-size:12px;color:rgba(232,213,163,.4);background:none;border:none;cursor:pointer;font-family:'Jost',sans-serif;transition:color .2s}
.topbar-back:hover{color:rgba(232,213,163,.8)}

/* ── PROGRESS ── */
.progress-wrap{width:100%;max-width:600px;padding:24px 24px 0}
.progress-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.progress-label{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9A8A72}
.progress-count{font-size:12px;color:#9A8A72}
.progress-bar{height:3px;background:rgba(139,105,20,.12);border-radius:2px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,#C9A84C,#E8D5A3);border-radius:2px;transition:width .4s ease}

/* ── MATCH BANNER ── */
.match-banner{width:100%;max-width:600px;padding:16px 24px 0}
.match-card{background:#fff;border:.5px solid rgba(139,105,20,.15);border-radius:8px;padding:14px 16px;display:flex;align-items:center;gap:12px}
.match-av{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,rgba(201,168,76,.25),rgba(201,168,76,.06));border:1.5px solid rgba(201,168,76,.3);display:flex;align-items:center;justify-content:center;font-family:'Cormorant Garamond',serif;font-size:16px;font-weight:600;color:#C9A84C;flex-shrink:0}
.match-info{flex:1}
.match-name{font-size:13px;font-weight:500;color:#2A1C06}
.match-sub{font-size:11px;color:#9A8A72;margin-top:1px}
.match-score{font-family:'Cormorant Garamond',serif;font-size:20px;color:#C9A84C;font-weight:500}
.match-score-lbl{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:rgba(201,168,76,.4);text-align:right}

/* ── DIMENSION LABEL ── */
.dim-wrap{width:100%;max-width:600px;padding:20px 24px 0}
.dim-pill{display:inline-flex;align-items:center;gap:6px;background:rgba(201,168,76,.1);border:.5px solid rgba(201,168,76,.25);border-radius:20px;padding:5px 12px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8B6914}

/* ── QUESTION CARD ── */
.q-wrap{width:100%;max-width:600px;padding:16px 24px 0}
.q-card{background:#fff;border:.5px solid rgba(139,105,20,.15);border-radius:12px;padding:28px 24px}
.q-number{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#B5A88C;margin-bottom:10px}
.q-text{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:400;color:#2A1C06;line-height:1.4;margin-bottom:24px}

/* Scale */
.scale-wrap{display:flex;flex-direction:column;gap:10px}
.scale-labels{display:flex;justify-content:space-between;font-size:10px;color:#B5A88C;padding:0 2px}
.scale-options{display:flex;gap:8px}
.scale-btn{flex:1;padding:14px 8px;border:.5px solid rgba(139,105,20,.2);border-radius:6px;background:#fff;cursor:pointer;font-size:13px;font-weight:400;color:#5A4A2E;transition:all .18s;text-align:center;font-family:'Jost',sans-serif}
.scale-btn:hover{border-color:rgba(201,168,76,.5);background:rgba(201,168,76,.05)}
.scale-btn.selected{background:#2A1C06;color:#E8D5A3;border-color:#2A1C06}

/* Single choice */
.single-options{display:flex;flex-direction:column;gap:8px}
.single-btn{width:100%;padding:13px 16px;border:.5px solid rgba(139,105,20,.2);border-radius:6px;background:#fff;cursor:pointer;font-size:13px;color:#2A1C06;text-align:left;transition:all .18s;font-family:'Jost',sans-serif;display:flex;align-items:center;gap:10px}
.single-btn:hover{border-color:rgba(201,168,76,.5);background:rgba(201,168,76,.05)}
.single-btn.selected{background:#2A1C06;color:#E8D5A3;border-color:#2A1C06}
.single-btn .radio{width:16px;height:16px;border-radius:50%;border:1.5px solid rgba(139,105,20,.3);flex-shrink:0;display:flex;align-items:center;justify-content:center}
.single-btn.selected .radio{border-color:#C9A84C;background:#C9A84C}
.single-btn.selected .radio::after{content:'';width:6px;height:6px;border-radius:50%;background:#0C0902}

/* Text */
.text-input{width:100%;border:.5px solid rgba(139,105,20,.2);border-radius:6px;padding:14px 16px;font-family:'Jost',sans-serif;font-size:14px;font-weight:300;color:#2A1C06;background:#fff;resize:none;outline:none;line-height:1.6;min-height:120px;transition:border-color .2s}
.text-input:focus{border-color:rgba(201,168,76,.5)}
.text-input::placeholder{color:#C0B09A}
.char-count{font-size:11px;color:#B5A88C;text-align:right;margin-top:6px}

/* Skip */
.skip-btn{display:block;margin-top:14px;font-size:12px;color:#B5A88C;background:none;border:none;cursor:pointer;font-family:'Jost',sans-serif;width:100%;text-align:center;transition:color .2s}
.skip-btn:hover{color:#9A8A72}

/* ── NAV ── */
.nav-wrap{width:100%;max-width:600px;padding:20px 24px 0;display:flex;align-items:center;gap:12px}
.btn-prev{flex:0 0 auto;padding:14px 20px;border:.5px solid rgba(139,105,20,.2);border-radius:4px;background:#fff;font-size:13px;color:#5A4A2E;cursor:pointer;font-family:'Jost',sans-serif;transition:all .2s}
.btn-prev:hover{background:rgba(201,168,76,.06)}
.btn-next{flex:1;padding:15px 24px;background:#2A1C06;color:#E8D5A3;border:none;border-radius:4px;font-size:13px;font-weight:500;letter-spacing:.04em;cursor:pointer;font-family:'Jost',sans-serif;transition:background .2s}
.btn-next:hover{background:#1A1005}
.btn-next:disabled{opacity:.4;cursor:not-allowed}

/* ── SCREENS ── */
.screen{display:none;width:100%;max-width:600px;padding:40px 24px;text-align:center}
.screen.active{display:block}

/* Intro screen */
.intro-icon{font-size:48px;margin-bottom:20px}
.intro-h{font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:400;color:#2A1C06;margin-bottom:12px;line-height:1.2}
.intro-h em{font-style:italic;color:#C9A84C}
.intro-p{font-size:14px;color:#5A4A2E;line-height:1.75;margin-bottom:8px}
.intro-dims{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:20px 0 28px}
.intro-dim{background:rgba(201,168,76,.08);border:.5px solid rgba(201,168,76,.2);border-radius:20px;padding:5px 12px;font-size:11px;color:#8B6914;letter-spacing:.08em}
.btn-start{width:100%;padding:16px;background:#C9A84C;color:#0C0902;border:none;border-radius:4px;font-size:14px;font-weight:500;letter-spacing:.04em;cursor:pointer;font-family:'Jost',sans-serif;margin-bottom:10px;transition:background .2s}
.btn-start:hover{background:#E8D5A3}

/* Waiting screen */
.waiting-icon{font-size:48px;margin-bottom:20px}
.waiting-h{font-family:'Cormorant Garamond',serif;font-size:28px;color:#2A1C06;margin-bottom:10px}
.waiting-p{font-size:14px;color:#5A4A2E;line-height:1.75;margin-bottom:24px}
.waiting-status{background:#fff;border:.5px solid rgba(139,105,20,.15);border-radius:8px;padding:16px 20px;margin-bottom:24px}
.status-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;font-size:13px}
.status-row:not(:last-child){border-bottom:.5px solid rgba(139,105,20,.08)}
.status-name{color:#5A4A2E}
.status-badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:500}
.badge-done{background:rgba(39,174,96,.1);color:#1e8a50}
.badge-pending{background:rgba(201,168,76,.1);color:#8B6914}

/* Result screen */
.result-icon{font-size:52px;margin-bottom:16px}
.result-h{font-family:'Cormorant Garamond',serif;font-size:32px;color:#2A1C06;margin-bottom:8px;line-height:1.2}
.result-h em{font-style:italic;color:#C9A84C}
.result-p{font-size:14px;color:#5A4A2E;line-height:1.75;margin-bottom:24px}
.score-display{background:#fff;border:.5px solid rgba(139,105,20,.15);border-radius:8px;padding:20px;margin-bottom:20px}
.score-big{font-family:'Cormorant Garamond',serif;font-size:56px;color:#C9A84C;line-height:1}
.score-lbl{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#B5A88C;margin-top:4px}
.btn-unlock{width:100%;padding:16px;background:#C9A84C;color:#0C0902;border:none;border-radius:4px;font-size:14px;font-weight:500;cursor:pointer;font-family:'Jost',sans-serif;margin-bottom:10px;transition:background .2s}
.btn-unlock:hover{background:#E8D5A3}
.btn-matches{width:100%;padding:14px;background:transparent;color:#5A4A2E;border:.5px solid rgba(139,105,20,.2);border-radius:4px;font-size:13px;cursor:pointer;font-family:'Jost',sans-serif;transition:all .2s}
.btn-matches:hover{background:rgba(201,168,76,.06)}

/* Declined screen */
.declined-p{font-size:14px;color:#5A4A2E;line-height:1.75;margin-bottom:24px;max-width:360px;margin-left:auto;margin-right:auto}

/* Toast */
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(14px);background:#2A1C06;color:#E8D5A3;padding:10px 20px;border-radius:3px;font-size:13px;z-index:999;opacity:0;transition:opacity .3s,transform .3s;pointer-events:none;border:.5px solid rgba(201,168,76,.2)}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

@media(max-width:480px){
  .q-text{font-size:19px}
  .scale-btn{padding:12px 4px;font-size:12px}
}
</style>
</head>
<body>
<div class="page" id="page">

  <!-- Top bar -->
  <div class="topbar">
    <a class="topbar-logo" href="/matches.html">✦ <span>Hassabe</span></a>
    <button class="topbar-back" onclick="window.location.href='/matches.html'">← Back to matches</button>
  </div>

  <!-- INTRO SCREEN -->
  <div class="screen active" id="screen-intro">
    <div class="intro-icon">✦</div>
    <h1 class="intro-h">Round 2 —<br><em>The Deeper Look</em></h1>
    <p class="intro-p">You and your match passed Round 1. Now it's time to go deeper.</p>
    <p class="intro-p" style="color:#9A8A72;font-size:13px">These questions explore the things that actually make or break a marriage. Answer honestly — there are no right answers.</p>
    <div class="intro-dims">
      <span class="intro-dim">Marriage</span>
      <span class="intro-dim">Finances</span>
      <span class="intro-dim">Family</span>
      <span class="intro-dim">Conflict</span>
      <span class="intro-dim">Readiness</span>
    </div>
    <div id="match-banner-intro" style="margin-bottom:24px"></div>
    <button class="btn-start" onclick="startQuestionnaire()">Begin Round 2 →</button>
    <p style="font-size:12px;color:#B5A88C">~10 minutes · Both partners must complete</p>
  </div>

  <!-- QUESTIONNAIRE SCREEN -->
  <div class="screen" id="screen-q">
    <!-- Progress -->
    <div class="progress-wrap" style="padding-top:20px">
      <div class="progress-top">
        <span class="progress-label">Round 2</span>
        <span class="progress-count" id="q-count">1 / 21</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:5%"></div></div>
    </div>

    <!-- Dimension label -->
    <div class="dim-wrap">
      <div class="dim-pill" id="dim-pill">Marriage</div>
    </div>

    <!-- Question card -->
    <div class="q-wrap">
      <div class="q-card">
        <div class="q-number" id="q-number">Question 1</div>
        <div class="q-text" id="q-text">Loading…</div>
        <div id="q-input"></div>
        <button class="skip-btn" id="skip-btn" onclick="skipQuestion()">Skip this question</button>
      </div>
    </div>

    <!-- Navigation -->
    <div class="nav-wrap">
      <button class="btn-prev" id="btn-prev" onclick="prevQuestion()">← Back</button>
      <button class="btn-next" id="btn-next" onclick="nextQuestion()" disabled>Continue →</button>
    </div>
  </div>

  <!-- WAITING SCREEN -->
  <div class="screen" id="screen-waiting">
    <div class="waiting-icon">⏳</div>
    <h2 class="waiting-h">You're done — waiting for your match</h2>
    <p class="waiting-p">Your Round 2 responses have been saved. We'll notify you as soon as your match completes theirs.</p>
    <div class="waiting-status" id="waiting-status"></div>
    <button class="btn-matches" onclick="window.location.href='/matches.html'">Back to matches</button>
  </div>

  <!-- RESULT APPROVED SCREEN -->
  <div class="screen" id="screen-approved">
    <div class="result-icon">💛</div>
    <h1 class="result-h">You're a<br><em>strong match</em></h1>
    <p class="result-p" id="approved-p">Your combined compatibility score puts you in the top tier. Unlock your conversation to begin.</p>
    <div class="score-display">
      <div class="score-big" id="combined-score">—</div>
      <div class="score-lbl">Combined Score</div>
    </div>
    <button class="btn-unlock" id="btn-unlock" onclick="goToPayment()">Unlock Conversation — $49.99 →</button>
    <button class="btn-matches" onclick="window.location.href='/matches.html'">Back to matches</button>
  </div>

  <!-- RESULT DECLINED SCREEN -->
  <div class="screen" id="screen-declined">
    <div class="result-icon" style="opacity:.5">—</div>
    <h1 class="result-h" style="color:#5A4A2E">Not the right fit<br>this time</h1>
    <p class="declined-p">Your combined score didn't reach the threshold for a strong match. This is rare and reflects deep value differences, not anything wrong with either of you.</p>
    <button class="btn-matches" onclick="window.location.href='/matches.html'">Back to matches</button>
  </div>

</div>
<div id="toast"></div>

<script>
'use strict';

const API   = window.HASSABE_CONFIG.API;
const TOKEN = localStorage.getItem('hassabe_token') || '';
const params  = new URLSearchParams(window.location.search);
const MATCH_ID = params.get('matchId');

if (!TOKEN || !MATCH_ID) window.location.href = '/matches.html';

/* ══════════════════════════════════════════════════
   QUESTIONS
══════════════════════════════════════════════════ */
const QUESTIONS = [
  // ── MARRIAGE (5) ──
  { id:'m1', dim:'marriage', type:'single', sensitive:false,
    text:'When do you see yourself getting married?',
    options:['Within the next year','In 1–2 years','In 2–3 years','In 3–5 years','I\'m not sure yet'] },
  { id:'m2', dim:'marriage', type:'scale5', sensitive:false,
    text:'How traditional do you want your marriage to be?',
    low:'Very modern', high:'Very traditional' },
  { id:'m3', dim:'marriage', type:'scale5', sensitive:false,
    text:'How important is family approval before getting married?',
    low:'Not important', high:'Essential' },
  { id:'m4', dim:'marriage', type:'single', sensitive:false,
    text:'How important is a formal engagement period before marriage?',
    options:['Not important at all','Somewhat important','Very important','Required by family/culture','Open to discussing'] },
  { id:'m5', dim:'marriage', type:'text', sensitive:false,
    text:'In your own words — what do you hope marriage feels like on an ordinary Tuesday?' },

  // ── FINANCES (4) ──
  { id:'f1', dim:'finances', type:'single', sensitive:true,
    text:'How would you prefer to handle finances in marriage?',
    options:['Fully joint — everything shared','Mostly joint with some personal money','Equal split — each pays half','Mostly separate with shared bills','Completely separate'] },
  { id:'f2', dim:'finances', type:'scale5', sensitive:true,
    text:'How do you feel about financial obligations to extended family (parents, siblings)?',
    low:'No obligation', high:'Strong obligation' },
  { id:'f3', dim:'finances', type:'scale5', sensitive:false,
    text:'How important is financial stability before getting married?',
    low:'Not a prerequisite', high:'Must be fully stable' },
  { id:'f4', dim:'finances', type:'single', sensitive:true,
    text:'Who should be the primary financial provider in the home?',
    options:['The man','The woman','Whoever earns more','Equally shared','Flexible — depends on circumstances'] },

  // ── FAMILY (4) ──
  { id:'fa1', dim:'family', type:'scale5', sensitive:false,
    text:'How involved do you expect your extended family to be in your married life?',
    low:'Not involved', high:'Very involved' },
  { id:'fa2', dim:'family', type:'single', sensitive:false,
    text:'How do you feel about living near or with in-laws?',
    options:['Prefer to live with them','Prefer to live nearby','Moderate distance is fine','Prefer to live far','No strong preference'] },
  { id:'fa3', dim:'family', type:'single', sensitive:false,
    text:'How do you envision dividing household responsibilities?',
    options:['Traditional — clear gender roles','Mostly traditional','Fully equal split','Based on each person\'s strengths','Flexible and situational'] },
  { id:'fa4', dim:'family', type:'text', sensitive:false,
    text:'How do you envision raising children in your faith and culture?' },

  // ── CONFLICT (4) ──
  { id:'c1', dim:'conflict', type:'single', sensitive:false,
    text:'When you\'re upset with your partner, you tend to:',
    options:['Need space before talking','Talk it through immediately','Depends on the situation','Write it out first','Pray or reflect before engaging'] },
  { id:'c2', dim:'conflict', type:'scale5', sensitive:false,
    text:'How important is it to resolve conflict before going to sleep?',
    low:'Not important', high:'Very important' },
  { id:'c3', dim:'conflict', type:'scale5', sensitive:false,
    text:'How comfortable are you with emotional vulnerability in a relationship?',
    low:'Very guarded', high:'Fully open' },
  { id:'c4', dim:'conflict', type:'text', sensitive:false,
    text:'Describe how you typically handle conflict in a close relationship.' },

  // ── READINESS (4) ──
  { id:'r1', dim:'readiness', type:'scale5', sensitive:false,
    text:'How ready do you feel for marriage right now?',
    low:'Not ready', high:'Completely ready' },
  { id:'r2', dim:'readiness', type:'single', sensitive:false,
    text:'Are there significant life changes coming in the next 2 years?',
    options:['Major career change','Relocating','Continuing education','Family obligations','Nothing major planned','Multiple things in motion'] },
  { id:'r3', dim:'readiness', type:'scale5', sensitive:false,
    text:'How emotionally available are you for a serious relationship right now?',
    low:'Limited capacity', high:'Fully available' },
  { id:'r4', dim:'readiness', type:'text', sensitive:false,
    text:'What\'s the one area of yourself you\'re still working on before marriage?' },
];

const DIM_LABELS = {
  marriage:  'Marriage',
  finances:  'Finances',
  family:    'Family',
  conflict:  'Conflict',
  readiness: 'Readiness',
};

/* ══════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════ */
let currentQ   = 0;
let answers    = {};   // question_id → { answer, answer_text, skipped }
let matchData  = null;

/* ══════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════ */
(async function init() {
  if (!TOKEN) return;

  // Load match status
  try {
    const res  = await fetch(`${API}/api/round2/${MATCH_ID}/status`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    });
    const data = await res.json();

    if (!res.ok) { toast(data.error || 'Failed to load match'); return; }

    matchData = data;

    // Already submitted — show waiting or result
    if (data.myR2Complete) {
      if (data.partnerR2Complete) {
        showResult();
      } else {
        showWaiting(data);
      }
      return;
    }

    // Check for draft
    try {
      const dr = await fetch(`${API}/api/round2/${MATCH_ID}/draft`, {
        headers: { 'Authorization': `Bearer ${TOKEN}` }
      });
      const draft = await dr.json();
      if (draft.hasDraft && draft.answers) {
        answers    = draft.answers;
        currentQ   = draft.current_question || 0;
        toast('Draft restored — continuing where you left off');
      }
    } catch {}

    // Load match info for banner
    const mr = await fetch(`${API}/api/matches/${MATCH_ID}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    });
    if (mr.ok) {
      const md = await mr.json();
      const m  = md.match || md;
      renderMatchBanner(m);
    }

  } catch (e) {
    toast('Could not load Round 2 status');
  }
})();

function renderMatchBanner(m) {
  const name     = m.person?.firstName || 'Your Match';
  const initials = name[0].toUpperCase();
  const sub      = [m.person?.age, m.person?.profession, m.person?.city].filter(Boolean).join(' · ');
  const score    = Math.round(m.score || m.r1_score || 0);

  document.getElementById('match-banner-intro').innerHTML = `
    <div class="match-card">
      <div class="match-av">${initials}</div>
      <div class="match-info">
        <div class="match-name">${name}</div>
        <div class="match-sub">${sub}</div>
      </div>
      <div style="text-align:right">
        <div class="match-score">${score}%</div>
        <div class="match-score-lbl">R1 Match</div>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════
   QUESTIONNAIRE
══════════════════════════════════════════════════ */
function startQuestionnaire() {
  showScreen('screen-q');
  renderQuestion();
}

function renderQuestion() {
  const q    = QUESTIONS[currentQ];
  const total = QUESTIONS.length;

  document.getElementById('q-count').textContent  = `${currentQ + 1} / ${total}`;
  document.getElementById('progress-fill').style.width = `${((currentQ + 1) / total) * 100}%`;
  document.getElementById('dim-pill').textContent  = DIM_LABELS[q.dim];
  document.getElementById('q-number').textContent  = `Question ${currentQ + 1}`;
  document.getElementById('q-text').textContent    = q.text;
  document.getElementById('btn-prev').style.display = currentQ === 0 ? 'none' : '';

  const saved = answers[q.id];

  // Render input
  const inputEl = document.getElementById('q-input');
  if (q.type === 'scale5') {
    const labels = ['1', '2', '3', '4', '5'];
    inputEl.innerHTML = `
      <div class="scale-wrap">
        <div class="scale-labels"><span>${q.low}</span><span>${q.high}</span></div>
        <div class="scale-options">
          ${labels.map((l, i) => `
            <button class="scale-btn ${saved?.answer === i+1 ? 'selected' : ''}"
              onclick="selectScale(${i+1})" data-val="${i+1}">${l}</button>
          `).join('')}
        </div>
      </div>`;
  } else if (q.type === 'single') {
    inputEl.innerHTML = `
      <div class="single-options">
        ${q.options.map((opt, i) => `
          <button class="single-btn ${saved?.answer === i ? 'selected' : ''}"
            onclick="selectSingle(${i}, '${opt.replace(/'/g,"\\'")}')">
            <div class="radio"></div>${opt}
          </button>
        `).join('')}
      </div>`;
  } else if (q.type === 'text') {
    const val = saved?.answer_text || '';
    inputEl.innerHTML = `
      <textarea class="text-input" id="text-input" placeholder="Write your answer here…"
        oninput="handleTextInput(this)" maxlength="500">${val}</textarea>
      <div class="char-count" id="char-count">${val.length} / 500</div>`;
  }

  updateNextBtn();
}

function selectScale(val) {
  const q = QUESTIONS[currentQ];
  answers[q.id] = { answer: val, answer_text: String(val), type: 'scale5', skipped: false };
  document.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('selected'));
  document.querySelector(`[data-val="${val}"]`)?.classList.add('selected');
  updateNextBtn();
  saveDraft();
}

function selectSingle(idx, text) {
  const q = QUESTIONS[currentQ];
  answers[q.id] = { answer: idx, answer_text: text, type: 'single', skipped: false };
  document.querySelectorAll('.single-btn').forEach(b => b.classList.remove('selected'));
  document.querySelectorAll('.single-btn')[idx]?.classList.add('selected');
  updateNextBtn();
  saveDraft();
}

function handleTextInput(el) {
  const q   = QUESTIONS[currentQ];
  const val = el.value;
  document.getElementById('char-count').textContent = `${val.length} / 500`;
  answers[q.id] = { answer: null, answer_text: val, type: 'text', skipped: false };
  updateNextBtn();
}

function updateNextBtn() {
  const q    = QUESTIONS[currentQ];
  const ans  = answers[q.id];
  const last = currentQ === QUESTIONS.length - 1;
  const btn  = document.getElementById('btn-next');

  let hasAnswer = false;
  if (ans?.skipped)        hasAnswer = true;
  else if (q.type === 'text') hasAnswer = (ans?.answer_text?.trim().length || 0) >= 10;
  else                     hasAnswer = ans?.answer !== undefined && ans.answer !== null;

  btn.disabled   = !hasAnswer;
  btn.textContent = last ? 'Submit Round 2 →' : 'Continue →';
}

function nextQuestion() {
  if (currentQ === QUESTIONS.length - 1) {
    submitRound2();
  } else {
    currentQ++;
    renderQuestion();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function prevQuestion() {
  if (currentQ > 0) {
    currentQ--;
    renderQuestion();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function skipQuestion() {
  const q = QUESTIONS[currentQ];
  answers[q.id] = { answer: null, answer_text: null, type: q.type, skipped: true };
  updateNextBtn();
  saveDraft();
  nextQuestion();
}

/* ══════════════════════════════════════════════════
   DRAFT SAVE
══════════════════════════════════════════════════ */
let draftTimer;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    try {
      await fetch(`${API}/api/round2/${MATCH_ID}/draft`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${TOKEN}` },
        body: JSON.stringify({ current_question: currentQ, answers }),
      });
    } catch {}
  }, 1500);
}

/* ══════════════════════════════════════════════════
   SUBMIT
══════════════════════════════════════════════════ */
async function submitRound2() {
  const btn = document.getElementById('btn-next');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  // Build responses array
  const responses = QUESTIONS.map(q => {
    const a = answers[q.id] || { skipped: true };
    return {
      question_id:  q.id,
      dimension:    q.dim,
      type:         q.type,
      answer:       a.skipped ? null : a.answer,
      answer_text:  a.skipped ? null : a.answer_text,
      sensitive:    q.sensitive,
      skipped:      !!a.skipped,
    };
  });

  try {
    const res  = await fetch(`${API}/api/round2/${MATCH_ID}`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${TOKEN}` },
      body: JSON.stringify({ responses }),
    });
    const data = await res.json();

    if (!res.ok) {
      toast(data.error || 'Submission failed. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Submit Round 2 →';
      return;
    }

    if (data.bothComplete) {
      showResult();
    } else {
      showWaiting({ myR2Complete: true, partnerR2Complete: false });
    }

  } catch (e) {
    toast('Network error. Please try again.');
    btn.disabled = false;
    btn.textContent = 'Submit Round 2 →';
  }
}

/* ══════════════════════════════════════════════════
   RESULT & WAITING
══════════════════════════════════════════════════ */
async function showResult() {
  try {
    const res  = await fetch(`${API}/api/round2/${MATCH_ID}/result`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    });
    const data = await res.json();

    if (data.approved) {
      const score = Math.round(data.scores?.combined || 0);
      document.getElementById('combined-score').textContent = `${score}%`;
      document.getElementById('approved-p').textContent =
        data.compatibilitySummary ||
        `Your combined compatibility score of ${score}% puts you in the top tier. Unlock your conversation to begin.`;
      showScreen('screen-approved');
    } else if (data.status === 'declined') {
      showScreen('screen-declined');
    } else {
      // Still scoring — show waiting
      showWaiting({ myR2Complete: true, partnerR2Complete: false });
    }
  } catch {
    showWaiting({ myR2Complete: true, partnerR2Complete: false });
  }
}

function showWaiting(data) {
  const myName      = 'You';
  const partnerName = matchData?.partner?.firstName || 'Your match';

  document.getElementById('waiting-status').innerHTML = `
    <div class="status-row">
      <span class="status-name">${myName}</span>
      <span class="status-badge badge-done">✓ Complete</span>
    </div>
    <div class="status-row">
      <span class="status-name">${partnerName}</span>
      <span class="status-badge ${data.partnerR2Complete ? 'badge-done' : 'badge-pending'}">
        ${data.partnerR2Complete ? '✓ Complete' : 'In progress…'}
      </span>
    </div>`;

  showScreen('screen-waiting');

  // Poll for partner completion every 15s
  if (!data.partnerR2Complete) {
    const poll = setInterval(async () => {
      try {
        const res  = await fetch(`${API}/api/round2/${MATCH_ID}/status`, {
          headers: { 'Authorization': `Bearer ${TOKEN}` }
        });
        const d = await res.json();
        if (d.partnerR2Complete) {
          clearInterval(poll);
          showResult();
        }
      } catch {}
    }, 15000);
  }
}

function goToPayment() {
  window.location.href = `/payment.html?matchId=${MATCH_ID}`;
}

/* ══════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

let toastT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 3500);
}
</script>
</body>
</html>
