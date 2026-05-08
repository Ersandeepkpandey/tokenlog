import * as vscode from 'vscode';
import * as path from 'path';
import { TokenTracker } from './tokenTracker';
import { AuthManager } from './authManager';
import { UsageSync } from './usageSync';
import { AllStats } from './types';
import { calcCost } from './pricing';

let tokenTracker: TokenTracker;
let authManager: AuthManager;
let usageSync: UsageSync;
let statusBarItem: vscode.StatusBarItem;
let dashboardPanel: vscode.WebviewPanel | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('aiTokenTracker');
  const model = config.get<string>('model', 'claude-sonnet-4');
  const claudeLogPath = config.get<string>('claudeLogPath', '');

  authManager = new AuthManager(context);
  tokenTracker = new TokenTracker(claudeLogPath, model);
  usageSync = new UsageSync(authManager, tokenTracker);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Start tracking immediately — no sign-in required
  tokenTracker.on('update', onStatsUpdate);
  tokenTracker.start();
  updateStatusBar(tokenTracker.getStats());

  // Background sync if already signed in
  authManager.isAuthenticated().then(isAuth => {
    if (isAuth) usageSync.start();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('aiTokenTracker.showDashboard', () => {
      showDashboardPanel(context);
    }),

    vscode.commands.registerCommand('aiTokenTracker.signIn', async () => {
      await doSignIn(context);
    }),

    vscode.commands.registerCommand('aiTokenTracker.signOut', async () => {
      await authManager.signOut();
      usageSync.stop();
      vscode.window.showInformationMessage('AI Token Tracker: Signed out.');
    }),

    vscode.commands.registerCommand('aiTokenTracker.resetSession', () => {
      tokenTracker.resetCurrentSession();
      vscode.window.showInformationMessage('AI Token Tracker: Current session reset.');
    }),

    vscode.commands.registerCommand('aiTokenTracker.setModel', async () => {
      const models = ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-3-5', 'gpt-4o', 'gpt-4o-mini'];
      const picked = await vscode.window.showQuickPick(models, { placeHolder: 'Select default AI model for cost calculation' });
      if (picked) {
        await vscode.workspace.getConfiguration('aiTokenTracker').update('model', picked, vscode.ConfigurationTarget.Global);
        tokenTracker.setModel(picked);
        vscode.window.showInformationMessage(`AI Token Tracker: Model set to ${picked}`);
      }
    }),

    vscode.commands.registerCommand('aiTokenTracker.exportData', async () => {
      await exportCsvLocally(tokenTracker.getStats());
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('aiTokenTracker.model')) {
        const newModel = vscode.workspace.getConfiguration('aiTokenTracker').get<string>('model', 'claude-sonnet-4');
        tokenTracker.setModel(newModel);
      }
    })
  );
}

function onStatsUpdate(stats: AllStats) {
  updateStatusBar(stats);
  if (dashboardPanel) {
    dashboardPanel.webview.postMessage({ type: 'update', data: stats });
  }
}

export async function deactivate() {
  tokenTracker?.stop();
  usageSync?.stop();
  await usageSync?.forceSync();
}

async function doSignIn(_context: vscode.ExtensionContext) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'AI Token Tracker: Opening sign-in...' },
    async () => {
      const session = await authManager.signIn();
      if (session) {
        vscode.window.showInformationMessage(`Signed in as ${session.email} — syncing enabled.`);
        usageSync.start();
      } else {
        vscode.window.showErrorMessage('AI Token Tracker: Sign-in failed or timed out.');
      }
    }
  );
}

function updateStatusBar(stats: AllStats) {
  const show = vscode.workspace.getConfiguration('aiTokenTracker').get<boolean>('showStatusBar', true);
  if (!show) { statusBarItem.hide(); return; }

  const s = stats.currentSession;
  const modelShort = (m: string) => m.replace('claude-', '').replace('gpt-', 'gpt/');

  if (s) {
    const sessionTokens = s.totalInput + s.totalOutput;
    statusBarItem.text = `$(pulse) ${modelShort(s.model)} ${fmtTokens(sessionTokens)} $${s.estimatedCost.toFixed(4)}`;
    statusBarItem.tooltip = new vscode.MarkdownString(
      `**Current session**\n\nModel: \`${s.model}\`\n` +
      `Input: ${fmtTokens(s.totalInput)}  Output: ${fmtTokens(s.totalOutput)}\n` +
      `Cache read: ${fmtTokens(s.totalCacheRead)}  Cache write: ${fmtTokens(s.totalCacheWrite)}\n` +
      `Cost: $${s.estimatedCost.toFixed(4)}  Turns: ${s.turns}\n\n` +
      `*Click to open dashboard*`
    );
  } else {
    statusBarItem.text = `$(pulse) AI Token Tracker`;
    statusBarItem.tooltip = 'AI Token Tracker — no active session\nClick to open dashboard';
  }

  statusBarItem.command = 'aiTokenTracker.showDashboard';
  statusBarItem.show();
}

function showDashboardPanel(context: vscode.ExtensionContext) {
  if (dashboardPanel) {
    dashboardPanel.reveal();
    return;
  }

  dashboardPanel = vscode.window.createWebviewPanel(
    'aiTokenTrackerDashboard',
    'AI Token Tracker',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  dashboardPanel.webview.html = getDashboardHtml(tokenTracker.getStats());

  dashboardPanel.webview.onDidReceiveMessage(async msg => {
    switch (msg.command) {
      case 'setModel': {
        const models = ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-3-5', 'gpt-4o', 'gpt-4o-mini'];
        const picked = await vscode.window.showQuickPick(models, { placeHolder: 'Select default AI model' });
        if (picked) {
          await vscode.workspace.getConfiguration('aiTokenTracker').update('model', picked, vscode.ConfigurationTarget.Global);
          tokenTracker.setModel(picked);
        }
        break;
      }
      case 'exportCsv':
        await exportCsvLocally(tokenTracker.getStats());
        break;
      case 'resetSession':
        tokenTracker.resetCurrentSession();
        break;
      case 'signIn':
        await doSignIn(context);
        break;
    }
  });

  dashboardPanel.onDidDispose(() => {
    dashboardPanel = undefined;
  });
}

async function exportCsvLocally(stats: AllStats) {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(require('os').homedir(), 'ai-token-usage.csv')),
    filters: { 'CSV Files': ['csv'] },
  });
  if (!uri) return;

  const header = 'Session ID,Project,Model,Date,Input Tokens,Output Tokens,Cache Read,Cache Write,Turns,Cost (USD)\n';
  const rows = stats.sessions.map(s => {
    const date = new Date(s.startTime).toISOString().slice(0, 10);
    return [
      s.sessionId, s.projectName, s.model, date,
      s.totalInput, s.totalOutput, s.totalCacheRead, s.totalCacheWrite,
      s.turns, s.estimatedCost.toFixed(6),
    ].join(',');
  }).join('\n');

  const enc = new TextEncoder();
  await vscode.workspace.fs.writeFile(uri, enc.encode(header + rows));
  vscode.window.showInformationMessage(`Exported ${stats.sessions.length} sessions to ${uri.fsPath}`);
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

function getDashboardHtml(stats: AllStats): string {
  const initialData = JSON.stringify(stats);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --accent:#4fc3f7;
  --accent-dim:rgba(79,195,247,.15);
  --green:#66bb6a;
  --amber:#ffa726;
  --red:#ef5350;
  --card-bg:var(--vscode-editorWidget-background);
  --border:var(--vscode-widget-border);
  --fg:var(--vscode-foreground);
  --fg-dim:var(--vscode-descriptionForeground);
  --bg:var(--vscode-editor-background);
  --hover:var(--vscode-list-hoverBackground);
  --btn-bg:var(--vscode-button-background);
  --btn-fg:var(--vscode-button-foreground);
}
body{font-family:var(--vscode-font-family);color:var(--fg);background:var(--bg);font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* ── Header ── */
.header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);flex-shrink:0}
.logo{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700}
.logo-icon{font-size:18px;animation:spin 8s linear infinite}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.header-btns{display:flex;gap:5px}
.btn{background:transparent;color:var(--fg-dim);border:1px solid var(--border);border-radius:5px;padding:4px 9px;cursor:pointer;font-size:11px;font-family:inherit;transition:all .15s}
.btn:hover{color:var(--fg);border-color:var(--accent);background:var(--accent-dim)}

/* ── Live session bar ── */
.live-bar{display:flex;align-items:center;gap:16px;padding:10px 14px;background:var(--accent-dim);border-bottom:1px solid var(--border);flex-shrink:0;min-height:52px}
.live-bar.idle{background:transparent}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0;animation:pulse-dot 1.2s ease-in-out infinite}
.live-bar.idle .live-dot{background:var(--fg-dim);animation:none}
@keyframes pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.live-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);flex-shrink:0}
.live-bar.idle .live-label{color:var(--fg-dim)}
.live-model{font-size:11px;color:var(--fg-dim);font-family:var(--vscode-editor-font-family,monospace);flex-shrink:0}
.live-metrics{display:flex;gap:14px;flex:1;flex-wrap:wrap}
.live-metric{display:flex;flex-direction:column;align-items:center;gap:1px}
.live-metric .lm-val{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;transition:color .3s}
.live-metric .lm-val.flash{color:var(--accent)}
.live-metric .lm-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-dim)}
.live-cost .lm-val{color:var(--amber)}
.live-sep{width:1px;height:32px;background:var(--border);flex-shrink:0}

/* ── Summary cards ── */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:7px;padding:10px 14px;flex-shrink:0}
.card{background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:9px 12px;position:relative;overflow:hidden;transition:border-color .2s}
.card::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,transparent 60%,rgba(255,255,255,.02));pointer-events:none}
.card:hover{border-color:var(--accent)}
.card label{font-size:10px;color:var(--fg-dim);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
.card .cv{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;transition:all .3s}
.card .cv.flash{transform:scale(1.06);color:var(--accent)}
.card .csub{font-size:10px;color:var(--fg-dim);margin-top:2px}
.card-accent{border-color:color-mix(in srgb,var(--accent) 40%,var(--border))}
.card-green{border-color:color-mix(in srgb,var(--green) 40%,var(--border))}

/* ── Nav tabs ── */
.nav{display:flex;gap:0;padding:0 14px;flex-shrink:0;border-bottom:1px solid var(--border)}
.nav-tab{padding:7px 13px;font-size:12px;cursor:pointer;border:none;background:transparent;color:var(--fg-dim);font-family:inherit;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s}
.nav-tab.active{color:var(--fg);border-bottom-color:var(--accent)}
.nav-tab:hover{color:var(--fg);background:var(--hover)}

/* ── Content ── */
.content{flex:1;overflow:hidden;position:relative}
.tab-page{display:none;height:100%;overflow-y:auto;padding:12px 14px}
.tab-page.active{display:block}

/* ── Chart ── */
.chart-wrap{background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:12px}
.chart-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.chart-title{font-size:10px;color:var(--fg-dim);text-transform:uppercase;letter-spacing:.05em}
.chart-total{font-size:11px;font-weight:600;color:var(--amber)}
.chart{display:flex;align-items:flex-end;gap:3px;height:72px;padding-bottom:4px;border-bottom:1px solid var(--border)}
.bar-wrap{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;cursor:default;min-width:0}
.bar{width:100%;background:var(--btn-bg);border-radius:3px 3px 0 0;opacity:.75;min-width:4px;min-height:3px;transition:height .4s cubic-bezier(.34,1.56,.64,1),opacity .15s}
.bar:hover{opacity:1;background:var(--accent)}
.bar-label{font-size:8px;color:var(--fg-dim);overflow:hidden;text-overflow:clip}
.bar.today{background:var(--accent);opacity:.9}
.chart-empty{height:72px;display:flex;align-items:center;justify-content:center;color:var(--fg-dim);font-size:12px}

/* ── Tables ── */
.section-hdr{font-size:10px;font-weight:600;color:var(--fg-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:7px;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:5px 8px;border-bottom:1px solid var(--border);color:var(--fg-dim);font-weight:600;font-size:10px;white-space:nowrap;position:sticky;top:0;background:var(--bg);text-transform:uppercase;letter-spacing:.04em}
td{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle;white-space:nowrap}
tr:hover td{background:var(--hover)}
tr.new-row td{animation:row-in .3s ease}
@keyframes row-in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
.cost{font-variant-numeric:tabular-nums;color:var(--amber)}
.mono{font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
.dim{color:var(--fg-dim)}
.blk{display:block}
.empty{text-align:center;padding:24px;color:var(--fg-dim);font-style:italic;font-size:12px}

/* ── Percent bars ── */
.pct-row{display:flex;align-items:center;gap:6px;min-width:90px}
.pct-track{flex:1;height:5px;background:var(--border);border-radius:3px;overflow:hidden}
.pct-fill{height:100%;background:var(--btn-bg);border-radius:3px;transition:width .5s ease}
.pct-fill.top{background:var(--accent)}
.pct-lbl{font-size:10px;color:var(--fg-dim);width:34px;text-align:right}

/* ── Model compare ── */
.cur-model td{font-weight:700;color:var(--fg)}
.green-txt{color:var(--green)}
.red-txt{color:var(--red)}
.compare-box{margin-top:14px;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
.compare-box h4{font-size:10px;font-weight:600;color:var(--fg-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
.compare-meta{font-size:11px;color:var(--fg-dim);margin-bottom:8px}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>

<div class="header">
  <div class="logo"><span class="logo-icon">◈</span> AI Token Tracker</div>
  <div class="header-btns">
    <button class="btn" onclick="vscode.postMessage({command:'setModel'})">⚙ Model</button>
    <button class="btn" onclick="vscode.postMessage({command:'exportCsv'})">↓ CSV</button>
    <button class="btn" onclick="vscode.postMessage({command:'resetSession'})">↺ Reset</button>
  </div>
</div>

<div id="live-bar" class="live-bar idle">
  <div class="live-dot"></div>
  <span class="live-label" id="live-label">Idle</span>
  <div class="live-sep"></div>
  <span class="live-model" id="live-model">—</span>
  <div class="live-sep"></div>
  <div class="live-metrics">
    <div class="live-metric"><span class="lm-val" id="ls-input">—</span><span class="lm-lbl">Input</span></div>
    <div class="live-metric"><span class="lm-val" id="ls-output">—</span><span class="lm-lbl">Output</span></div>
    <div class="live-metric"><span class="lm-val" id="ls-cache">—</span><span class="lm-lbl">Cache</span></div>
    <div class="live-metric"><span class="lm-val" id="ls-turns">—</span><span class="lm-lbl">Turns</span></div>
    <div class="live-metric live-cost"><span class="lm-val" id="ls-cost">—</span><span class="lm-lbl">Cost</span></div>
  </div>
</div>

<div class="cards">
  <div class="card card-accent">
    <label>Today</label>
    <div class="cv" id="c-today-cost">$0.0000</div>
    <div class="csub" id="c-today-tok">0 tokens</div>
  </div>
  <div class="card">
    <label>This Month</label>
    <div class="cv" id="c-month">$0.0000</div>
    <div class="csub" id="c-month-lbl"></div>
  </div>
  <div class="card">
    <label>All-Time Cost</label>
    <div class="cv" id="c-total-cost">$0.0000</div>
    <div class="csub" id="c-sessions">0 sessions</div>
  </div>
  <div class="card">
    <label>Total Tokens</label>
    <div class="cv" id="c-tokens">0</div>
    <div class="csub" id="c-tok-breakdown"></div>
  </div>
  <div class="card card-green">
    <label>Cache Reads</label>
    <div class="cv" id="c-cache">0</div>
    <div class="csub" id="c-cache-write"></div>
  </div>
</div>

<div class="nav">
  <button class="nav-tab active" onclick="showPage('overview',this)">Overview</button>
  <button class="nav-tab" onclick="showPage('sessions',this)">Sessions</button>
  <button class="nav-tab" onclick="showPage('models',this)">Models</button>
  <button class="nav-tab" onclick="showPage('projects',this)">Projects</button>
</div>

<div class="content">
  <div id="overview" class="tab-page active">
    <div class="chart-wrap">
      <div class="chart-hdr">
        <span class="chart-title">Daily Cost — last 30 days</span>
        <span class="chart-total" id="chart-total"></span>
      </div>
      <div id="chart" class="chart"><div class="chart-empty">No data yet</div></div>
    </div>
    <div class="section-hdr">Recent Sessions</div>
    <table>
      <thead><tr><th>Time</th><th>Model</th><th>Project</th><th>Input</th><th>Output</th><th>Cost</th><th>Turns</th></tr></thead>
      <tbody id="recent-body"><tr><td colspan="7" class="empty">No sessions yet — start using Claude Code.</td></tr></tbody>
    </table>
  </div>

  <div id="sessions" class="tab-page">
    <table>
      <thead><tr><th>Time</th><th>Model</th><th>Project</th><th>Input</th><th>Output</th><th>Cache</th><th>Cost</th><th>Turns</th></tr></thead>
      <tbody id="sessions-body"><tr><td colspan="8" class="empty">No sessions yet.</td></tr></tbody>
    </table>
  </div>

  <div id="models" class="tab-page">
    <table>
      <thead><tr><th>Model</th><th>Sessions</th><th>Input</th><th>Output</th><th>Cost</th><th>Share</th></tr></thead>
      <tbody id="models-body"><tr><td colspan="6" class="empty">No model data yet.</td></tr></tbody>
    </table>
    <div class="compare-box" id="compare-box" style="display:none">
      <h4>Model Comparison — Current Session</h4>
      <div class="compare-meta" id="compare-meta"></div>
      <table>
        <thead><tr><th>Model</th><th>Est. Cost</th><th>vs. Current</th></tr></thead>
        <tbody id="compare-body"></tbody>
      </table>
    </div>
  </div>

  <div id="projects" class="tab-page">
    <table>
      <thead><tr><th>Project</th><th>Sessions</th><th>Tokens</th><th>Cost</th><th>Share</th></tr></thead>
      <tbody id="projects-body"><tr><td colspan="5" class="empty">No project data yet.</td></tr></tbody>
    </table>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
const PRICING = {
  'claude-opus-4':     {input:15,output:75,cacheRead:1.5,cacheWrite:18.75},
  'claude-opus-4-5':   {input:15,output:75,cacheRead:1.5,cacheWrite:18.75},
  'claude-sonnet-4':   {input:3,output:15,cacheRead:.3,cacheWrite:3.75},
  'claude-sonnet-4-5': {input:3,output:15,cacheRead:.3,cacheWrite:3.75},
  'claude-haiku-3-5':  {input:.8,output:4,cacheRead:.08,cacheWrite:1},
  'gpt-4o':            {input:2.5,output:10,cacheRead:1.25,cacheWrite:0},
  'gpt-4o-mini':       {input:.15,output:.6,cacheRead:.075,cacheWrite:0},
};
const ALL_MODELS = Object.keys(PRICING);
const DEFAULT_P = {input:3,output:15,cacheRead:.3,cacheWrite:3.75};

function calcCost(model,t){
  const p=PRICING[model]||DEFAULT_P,M=1e6;
  return t.input/M*p.input+t.output/M*p.output+t.cacheRead/M*p.cacheRead+t.cacheWrite/M*p.cacheWrite;
}

function fmt(n){
  if(n>=1e6)return(n/1e6).toFixed(1)+'M';
  if(n>=1e3)return(n/1e3).toFixed(1)+'K';
  return String(n);
}

function flash(el){
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(()=>el.classList.remove('flash'),600);
}

function set(id,val,doFlash=false){
  const el=document.getElementById(id);
  if(!el)return;
  if(el.textContent!==val){
    el.textContent=val;
    if(doFlash)flash(el);
  }
}

function render(data){
  const sessions=data.sessions||[];
  const cur=data.currentSession;
  const todayStr=new Date().toLocaleDateString('en-CA');
  const monthPrefix=todayStr.slice(0,7);

  // ── Live bar ──
  const lb=document.getElementById('live-bar');
  if(cur){
    lb.classList.remove('idle');
    document.getElementById('live-label').textContent='● Live';
    document.getElementById('live-model').textContent=cur.model;
    set('ls-input', fmt(cur.totalInput),true);
    set('ls-output',fmt(cur.totalOutput),true);
    set('ls-cache', fmt(cur.totalCacheRead),true);
    set('ls-turns', String(cur.turns),true);
    set('ls-cost',  '$'+cur.estimatedCost.toFixed(4),true);
  } else {
    lb.classList.add('idle');
    document.getElementById('live-label').textContent='Idle';
    document.getElementById('live-model').textContent='No active session';
    ['ls-input','ls-output','ls-cache','ls-turns','ls-cost'].forEach(id=>set(id,'—'));
  }

  // ── Aggregate by date ──
  const byDate=new Map();
  const byModel=new Map();
  const byProject=new Map();
  let totalCacheRead=0,totalCacheWrite=0;
  for(const s of sessions){
    const d=new Date(s.startTime).toLocaleDateString('en-CA');
    const ex=byDate.get(d)||{input:0,output:0,cost:0,turns:0,sessions:0};
    byDate.set(d,{input:ex.input+s.totalInput,output:ex.output+s.totalOutput,cost:ex.cost+s.estimatedCost,turns:ex.turns+s.turns,sessions:ex.sessions+1});
    const em=byModel.get(s.model)||{cost:0,input:0,output:0,sessions:0,turns:0};
    byModel.set(s.model,{cost:em.cost+s.estimatedCost,input:em.input+s.totalInput,output:em.output+s.totalOutput,sessions:em.sessions+1,turns:em.turns+s.turns});
    const ep=byProject.get(s.projectName)||{cost:0,input:0,output:0,sessions:0,turns:0};
    byProject.set(s.projectName,{cost:ep.cost+s.estimatedCost,input:ep.input+s.totalInput,output:ep.output+s.totalOutput,sessions:ep.sessions+1,turns:ep.turns+s.turns});
    totalCacheRead+=s.totalCacheRead; totalCacheWrite+=s.totalCacheWrite;
  }

  const todayD=byDate.get(todayStr)||{cost:0,input:0,output:0};
  let monthCost=0;
  for(const[d,v]of byDate)if(d.startsWith(monthPrefix))monthCost+=v.cost;
  const totalCost=data.allTimeTotalCost||0;

  // ── Cards ──
  set('c-today-cost','$'+todayD.cost.toFixed(4),true);
  set('c-today-tok',fmt(todayD.input+todayD.output)+' tokens');
  set('c-month','$'+monthCost.toFixed(4),true);
  set('c-month-lbl',new Date().toLocaleDateString('en-US',{month:'long'}));
  set('c-total-cost','$'+totalCost.toFixed(4),true);
  set('c-sessions',sessions.length+' sessions');
  set('c-tokens',fmt(data.allTimeTotalInput+data.allTimeTotalOutput),true);
  set('c-tok-breakdown',fmt(data.allTimeTotalInput)+' in · '+fmt(data.allTimeTotalOutput)+' out');
  set('c-cache',fmt(totalCacheRead),true);
  set('c-cache-write',fmt(totalCacheWrite)+' written');

  // ── Chart ──
  set('chart-total','$'+totalCost.toFixed(2)+' total');
  const sortedDays=Array.from(byDate.entries()).sort(([a],[b])=>a<b?-1:1).slice(-30);
  const maxCost=Math.max(...sortedDays.map(([,d])=>d.cost),0.0001);
  const chartEl=document.getElementById('chart');
  if(sortedDays.length===0){
    chartEl.innerHTML='<div class="chart-empty">No data yet</div>';
  } else {
    chartEl.innerHTML=sortedDays.map(([date,d])=>{
      const h=Math.max(3,Math.round(d.cost/maxCost*68));
      const day=new Date(date+'T12:00:00').getDate();
      const isToday=date===todayStr;
      const label=new Date(date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
      return \`<div class="bar-wrap" title="\${label}: $\${d.cost.toFixed(4)}">
        <div class="bar\${isToday?' today':''}" style="height:\${h}px"></div>
        <div class="bar-label">\${day}</div>
      </div>\`;
    }).join('');
  }

  // ── Recent sessions ──
  const recentEl=document.getElementById('recent-body');
  if(sessions.length===0){
    recentEl.innerHTML='<tr><td colspan="7" class="empty">No sessions yet — start using Claude Code.</td></tr>';
  } else {
    recentEl.innerHTML=sessions.slice(0,10).map(s=>{
      const t=new Date(s.startTime).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      return \`<tr>
        <td class="dim">\${t}</td>
        <td class="mono">\${s.model}</td>
        <td>\${s.projectName}</td>
        <td>\${fmt(s.totalInput)}</td>
        <td>\${fmt(s.totalOutput)}</td>
        <td class="cost">$\${s.estimatedCost.toFixed(4)}</td>
        <td>\${s.turns}</td>
      </tr>\`;
    }).join('');
  }

  // ── All sessions ──
  const sessEl=document.getElementById('sessions-body');
  if(sessions.length===0){
    sessEl.innerHTML='<tr><td colspan="8" class="empty">No sessions yet.</td></tr>';
  } else {
    sessEl.innerHTML=sessions.map(s=>{
      const t=new Date(s.startTime).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      return \`<tr>
        <td class="dim">\${t}</td>
        <td class="mono">\${s.model}</td>
        <td>\${s.projectName}</td>
        <td>\${fmt(s.totalInput)}</td>
        <td>\${fmt(s.totalOutput)}</td>
        <td>\${fmt(s.totalCacheRead)}</td>
        <td class="cost">$\${s.estimatedCost.toFixed(4)}</td>
        <td>\${s.turns}</td>
      </tr>\`;
    }).join('');
  }

  // ── Models ──
  const modArr=Array.from(byModel.entries()).sort(([,a],[,b])=>b.cost-a.cost);
  const modEl=document.getElementById('models-body');
  if(modArr.length===0){
    modEl.innerHTML='<tr><td colspan="6" class="empty">No model data yet.</td></tr>';
  } else {
    modEl.innerHTML=modArr.map(([model,d],i)=>{
      const pct=totalCost>0?(d.cost/totalCost*100):0;
      return \`<tr>
        <td class="mono">\${model}</td>
        <td>\${d.sessions}</td>
        <td>\${fmt(d.input)}</td>
        <td>\${fmt(d.output)}</td>
        <td class="cost">$\${d.cost.toFixed(4)}</td>
        <td><div class="pct-row"><div class="pct-track"><div class="pct-fill\${i===0?' top':''}" style="width:\${pct.toFixed(1)}%"></div></div><span class="pct-lbl">\${pct.toFixed(1)}%</span></div></td>
      </tr>\`;
    }).join('');
  }

  // ── Model comparison ──
  const compareBox=document.getElementById('compare-box');
  if(cur&&cur.totalInput>0){
    compareBox.style.display='block';
    set('compare-meta',\`Based on \${fmt(cur.totalInput)} input + \${fmt(cur.totalOutput)} output · Current: \${cur.model}\`);
    document.getElementById('compare-body').innerHTML=ALL_MODELS.map(m=>{
      const cost=calcCost(m,{input:cur.totalInput,output:cur.totalOutput,cacheRead:cur.totalCacheRead,cacheWrite:cur.totalCacheWrite});
      const isCur=m===cur.model;
      const diff=cur.estimatedCost>0?((cur.estimatedCost-cost)/cur.estimatedCost*100):0;
      const diffHtml=isCur?'<span class="dim">current</span>'
        :diff>0.1?\`<span class="green-txt">save \${diff.toFixed(1)}%</span>\`
        :diff<-0.1?\`<span class="red-txt">\${Math.abs(diff).toFixed(1)}% more</span>\`
        :'<span class="dim">~same</span>';
      return \`<tr\${isCur?' class="cur-model"':''}>
        <td class="mono">\${m}\${isCur?' <span class="dim">(current)</span>':''}</td>
        <td class="cost">$\${cost.toFixed(6)}</td>
        <td>\${diffHtml}</td>
      </tr>\`;
    }).join('');
  } else {
    compareBox.style.display='none';
  }

  // ── Projects ──
  const projArr=Array.from(byProject.entries()).sort(([,a],[,b])=>b.cost-a.cost);
  const projEl=document.getElementById('projects-body');
  if(projArr.length===0){
    projEl.innerHTML='<tr><td colspan="5" class="empty">No project data yet.</td></tr>';
  } else {
    projEl.innerHTML=projArr.map(([proj,d],i)=>{
      const pct=totalCost>0?(d.cost/totalCost*100):0;
      return \`<tr>
        <td>\${proj}</td>
        <td>\${d.sessions}</td>
        <td>\${fmt(d.input+d.output)}</td>
        <td class="cost">$\${d.cost.toFixed(4)}</td>
        <td><div class="pct-row"><div class="pct-track"><div class="pct-fill\${i===0?' top':''}" style="width:\${pct.toFixed(1)}%"></div></div><span class="pct-lbl">\${pct.toFixed(1)}%</span></div></td>
      </tr>\`;
    }).join('');
  }
}

function showPage(name,btn){
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-page').forEach(t=>t.classList.remove('active'));
  document.getElementById(name).classList.add('active');
  btn.classList.add('active');
}

window.addEventListener('message',e=>{
  if(e.data.type==='update')render(e.data.data);
});

// Initial render
render(${initialData});
</script>
</body>
</html>`;
}

function formatDateLabel(dateStr: string): string {
  const today     = new Date().toLocaleDateString('en-CA');
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA');
  if (dateStr === today)     return 'Today';
  if (dateStr === yesterday) return 'Yesterday';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
