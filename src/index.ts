#!/usr/bin/env node
/**
 * Claude Task Monitor
 * Real-time task monitor for Claude Code task lists
 *
 * Usage: npx claude-task-monitor
 */

import * as chokidar from "chokidar";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";

// === Types (self-contained) ===
interface ClaudeTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  blocks: string[];
  blockedBy: string[];
  owner?: string;
}

interface ClaudeTaskList {
  id: string;
  tasks: ClaudeTask[];
  lastModified: Date;
}

interface TaskListSummary {
  id: string;
  path: string;
  taskCount: number;
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  lastModified: Date;
  hasPrompt: boolean;
}

interface TaskMonitorData {
  taskLists: ClaudeTaskList[];
  availableLists: TaskListSummary[];
  selectedListId: string;
  templates: string[];
  projectDir: string;
}

// === Monitor Config ===
interface MonitorConfig {
  projectDir: string;
  pollInterval: number;
  agentNames: string[];
}

const DATA_DIR = process.env.CLAUDE_TASK_MONITOR_DATA_DIR
  || path.join(os.homedir(), '.claude', 'claude-task-monitor');
const CONFIG_FILE = path.join(DATA_DIR, 'monitor-config.json');

const DEFAULT_CONFIG: MonitorConfig = {
  projectDir: process.cwd(),
  pollInterval: 2000,
  agentNames: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega']
};

let currentConfig: MonitorConfig = { ...DEFAULT_CONFIG };

function loadConfig(): MonitorConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        projectDir: typeof parsed.projectDir === 'string' && parsed.projectDir.length > 0 ? parsed.projectDir : DEFAULT_CONFIG.projectDir,
        pollInterval: typeof parsed.pollInterval === 'number' && parsed.pollInterval >= 500 && parsed.pollInterval <= 60000 ? parsed.pollInterval : DEFAULT_CONFIG.pollInterval,
        agentNames: Array.isArray(parsed.agentNames) && parsed.agentNames.length > 0 && parsed.agentNames.every((n: unknown) => typeof n === 'string' && n.length > 0) ? parsed.agentNames : DEFAULT_CONFIG.agentNames,
      };
    }
  } catch (err) {
    console.error('[Config] Failed to load config, using defaults:', err);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: MonitorConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

function validateConfig(input: Record<string, unknown>): { valid: boolean; config?: MonitorConfig; error?: string } {
  const config: MonitorConfig = { ...currentConfig };

  if ('projectDir' in input) {
    if (typeof input.projectDir !== 'string' || input.projectDir.trim().length === 0) {
      return { valid: false, error: 'projectDir must be a non-empty string' };
    }
    config.projectDir = input.projectDir.trim();
  }

  if ('pollInterval' in input) {
    const val = Number(input.pollInterval);
    if (isNaN(val) || val < 500 || val > 60000) {
      return { valid: false, error: 'pollInterval must be a number between 500 and 60000' };
    }
    config.pollInterval = val;
  }

  if ('agentNames' in input) {
    if (!Array.isArray(input.agentNames) || input.agentNames.length === 0) {
      return { valid: false, error: 'agentNames must be a non-empty array of strings' };
    }
    for (const name of input.agentNames) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return { valid: false, error: 'Each agent name must be a non-empty string' };
      }
    }
    config.agentNames = input.agentNames.map((n: string) => n.trim());
  }

  return { valid: true, config };
}

// === Configuration ===
const TASKS_DIR = path.join(os.homedir(), ".claude", "tasks");
const ARCHIVE_DIR = path.join(TASKS_DIR, ".archive");
const OUTPUT_DIR = process.env.CLAUDE_TASK_MONITOR_OUTPUT || DATA_DIR;
const DATA_FILE = path.join(OUTPUT_DIR, "task-monitor-data.json");
const HTML_FILE = path.join(OUTPUT_DIR, "task-monitor.html");

// Cache task data so we can archive it when Claude Code deletes the file
const taskDataCache = new Map<string, { tasks: ClaudeTask[], lastModified: Date }>();

// === Embedded CSS ===
const CSS = `* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
  background: #0d1117;
  color: #c9d1d9;
  padding: 24px;
  min-height: 100vh;
}

#launch {
  position: sticky;
  top: 0;
  z-index: 100;
  background: #0d1117;
  padding-top: 0;
}

.control-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  margin-bottom: 20px;
}

.control-bar .title {
  font-size: 14px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.control-bar .divider {
  width: 1px;
  height: 24px;
  background: #30363d;
}

.control-bar .task-list-select {
  background: #0d1117;
  color: #c9d1d9;
  border: 1px solid #30363d;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  min-width: 200px;
}

.control-bar .task-list-select:hover { border-color: #484f58; }
.control-bar .task-list-select:focus { outline: none; border-color: #58a6ff; }

.control-bar .launch-btn {
  background: #238636;
  color: #fff;
  border: none;
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}

.control-bar .launch-btn:hover { background: #2ea043; }
.control-bar .launch-danger-btn { background: #da3633; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; white-space: nowrap; }
.control-bar .launch-danger-btn:hover { background: #e55c59; }
.control-bar .agent-name { color: #58a6ff; font-size: 13px; font-weight: 500; }
.control-bar .reset-btn { color: #6e7681; background: none; border: none; font-size: 12px; cursor: pointer; font-family: inherit; padding: 4px 8px; }
.control-bar .reset-btn:hover { color: #8b949e; }
.control-bar .settings-btn { color: #8b949e; background: none; border: 1px solid #30363d; font-size: 12px; cursor: pointer; font-family: inherit; padding: 4px 10px; border-radius: 4px; }
.control-bar .settings-btn:hover { color: #c9d1d9; border-color: #484f58; }
.control-bar .spacer { flex: 1; }
.control-bar .stats { display: flex; gap: 16px; font-size: 13px; color: #6e7681; }
.control-bar .stats .value { color: #f0f6fc; font-weight: 500; }
.control-bar .stats .available { color: #58a6ff; }
.control-bar .stats .in-progress { color: #a371f7; }
.control-bar .stats .done { color: #3fb950; }

.agents-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: rgba(163, 113, 247, 0.08);
  border: 1px solid rgba(163, 113, 247, 0.2);
  border-radius: 6px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.agents-bar .label { font-size: 12px; font-weight: 600; color: #a371f7; text-transform: uppercase; letter-spacing: 0.5px; }
.agents-bar .agent { display: inline-flex; align-items: center; gap: 8px; background: #21262d; padding: 4px 10px; border-radius: 4px; font-size: 13px; }
.agents-bar .agent-owner { color: #a371f7; font-weight: 500; }
.agents-bar .agent-id { color: #6e7681; font-size: 12px; }
.agents-bar .agent-task { color: #c9d1d9; }
.agents-bar .agent .spinner { color: #a371f7; }

.empty { color: #6e7681; padding: 40px; text-align: center; }
.empty code { display: block; margin-top: 16px; color: #58a6ff; background: #161b22; padding: 12px 16px; border-radius: 6px; font-size: 14px; }

.task-list { margin-bottom: 24px; }
.task-list-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.task-list-header h2 { font-size: 15px; font-weight: 600; color: #f0f6fc; }
.task-list-header .meta { font-size: 13px; color: #6e7681; }

.status-summary { font-size: 13px; color: #6e7681; margin-left: 20px; margin-bottom: 8px; }
.status-summary .active { color: #a371f7; }
.status-summary .pending { color: #6e7681; }
.status-summary .done { color: #3fb950; }

.task { display: flex; align-items: center; gap: 10px; padding: 6px 0 6px 20px; font-size: 14px; }
.task .icon { width: 14px; text-align: center; }
.task .icon.completed { color: #3fb950; }
.task .icon.in_progress { color: #a371f7; }
.task .icon.pending { color: #484f58; }
.task.available .icon { color: #58a6ff; }
.task.blocked .icon { color: #d29922; }
.task.available .subject { color: #f0f6fc; }
.task .id { color: #6e7681; font-size: 13px; min-width: 30px; }
.task .subject { flex: 1; }
.task.completed .subject { color: #6e7681; }
.task.in_progress .subject { color: #f0f6fc; font-weight: 500; }
.task .suffix { display: flex; gap: 12px; font-size: 13px; }
.task .owner { color: #58a6ff; }
.task.in_progress .owner { color: #a371f7; }
.task.completed .owner { color: #3fb950; }
.task .blocked { color: #d29922; }

.commands { border-top: 1px solid #30363d; padding-top: 20px; margin-top: 20px; }
.commands h3 { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: #f0f6fc; }
.commands .label { color: #58a6ff; font-size: 13px; margin-bottom: 4px; }
.commands code { display: block; color: #f0f6fc; font-size: 13px; margin-bottom: 12px; user-select: all; }
.commands code.dim { color: #6e7681; }

.footer { color: #6e7681; font-size: 13px; margin-top: 20px; }

.available-label { color: #58a6ff; font-size: 0.75rem; font-weight: 500; margin-left: 12px; cursor: pointer; }
.available-label:hover { text-decoration: underline; }

.code-mode-select {
  background: #0d1117;
  color: #c9d1d9;
  border: 1px solid #30363d;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.code-mode-select:hover { border-color: #484f58; }
.code-mode-select:focus { outline: none; border-color: #58a6ff; }

.review-btn {
  background: rgba(163, 113, 247, 0.15);
  color: #a371f7;
  border: 1px solid rgba(163, 113, 247, 0.3);
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.review-btn:hover { background: rgba(163, 113, 247, 0.25); border-color: rgba(163, 113, 247, 0.5); }
.codex-name { color: #a371f7; font-size: 13px; font-weight: 500; }

.toast { position: fixed; bottom: 24px; right: 24px; background: #238636; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 14px; opacity: 0; transform: translateY(10px); transition: opacity 0.2s, transform 0.2s; z-index: 1000; max-width: 400px; }
.toast.show { opacity: 1; transform: translateY(0); }
.toast code { display: block; margin-top: 8px; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; font-size: 12px; word-break: break-all; }

@keyframes spin { 0% { content: "\\2807"; } 10% { content: "\\2819"; } 20% { content: "\\2839"; } 30% { content: "\\2838"; } 40% { content: "\\283C"; } 50% { content: "\\2834"; } 60% { content: "\\2826"; } 70% { content: "\\2827"; } 80% { content: "\\2807"; } 90% { content: "\\280F"; } }
.spinner::before { content: "\\2807"; animation: spin 1s steps(10) infinite; }

.settings-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 2000; justify-content: center; align-items: center; }
.settings-overlay.open { display: flex; }
.settings-panel { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; width: 480px; max-width: 90vw; }
.settings-panel h2 { font-size: 16px; font-weight: 600; color: #f0f6fc; margin-bottom: 20px; }
.settings-field { margin-bottom: 16px; }
.settings-field label { display: block; font-size: 13px; color: #8b949e; margin-bottom: 6px; }
.settings-field input, .settings-field textarea { width: 100%; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 10px; border-radius: 4px; font-size: 13px; font-family: inherit; }
.settings-field input:focus, .settings-field textarea:focus { outline: none; border-color: #58a6ff; }
.settings-field textarea { resize: vertical; min-height: 60px; }
.settings-field .hint { font-size: 11px; color: #6e7681; margin-top: 4px; }
.settings-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
.settings-actions button { padding: 6px 16px; border-radius: 4px; font-size: 13px; font-family: inherit; cursor: pointer; border: none; }
.settings-actions .save-btn { background: #238636; color: #fff; }
.settings-actions .save-btn:hover { background: #2ea043; }
.settings-actions .cancel-btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; }
.settings-actions .cancel-btn:hover { background: #30363d; }
.settings-status { font-size: 12px; margin-top: 12px; min-height: 18px; }
.settings-status.success { color: #3fb950; }
.settings-status.error { color: #f85149; }`;

// === Embedded JavaScript ===
const JS = `let MONITOR_DATA = window.__MONITOR_DATA__ || null;
let TASK_DATA = MONITOR_DATA ? MONITOR_DATA.taskLists : [];
let fetchFailed = false;

let AGENT_NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];

let pollInterval = 2000;
let pollTimer = null;

function restartPolling(interval) {
  pollInterval = interval;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { fetchData(); }, pollInterval);
  const footer = document.querySelector('.footer');
  if (footer) footer.textContent = 'Real-time updates (polling every ' + (pollInterval / 1000) + 's)';
}

async function loadSettings() {
  try {
    const resp = await fetch('/api/config', { cache: 'no-store' });
    if (!resp.ok) return;
    const config = await resp.json();
    if (config.agentNames && Array.isArray(config.agentNames) && config.agentNames.length > 0) {
      AGENT_NAMES = config.agentNames;
    }
    if (config.pollInterval && config.pollInterval >= 500 && config.pollInterval <= 60000) {
      restartPolling(config.pollInterval);
    }
  } catch (e) {
    // Settings API not available, use defaults
  }
}

function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  // Populate fields from current known config
  fetch('/api/config', { cache: 'no-store' }).then(r => r.json()).then(config => {
    document.getElementById('settings-projectDir').value = config.projectDir || '';
    document.getElementById('settings-pollInterval').value = config.pollInterval || 2000;
    document.getElementById('settings-agentNames').value = (config.agentNames || []).join(', ');
    document.getElementById('settings-status').textContent = '';
    document.getElementById('settings-status').className = 'settings-status';
    overlay.classList.add('open');
  }).catch(() => {
    overlay.classList.add('open');
  });
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
}

async function saveSettings() {
  const statusEl = document.getElementById('settings-status');
  statusEl.textContent = 'Saving...';
  statusEl.className = 'settings-status';

  const projectDir = document.getElementById('settings-projectDir').value.trim();
  const pollIntervalVal = parseInt(document.getElementById('settings-pollInterval').value, 10);
  const agentNamesRaw = document.getElementById('settings-agentNames').value;
  const agentNames = agentNamesRaw.split(',').map(s => s.trim()).filter(s => s.length > 0);

  try {
    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir, pollInterval: pollIntervalVal, agentNames })
    });
    const result = await resp.json();
    if (!resp.ok) {
      statusEl.textContent = result.error || 'Save failed';
      statusEl.className = 'settings-status error';
      return;
    }
    // Apply changes immediately
    if (result.agentNames) {
      AGENT_NAMES = result.agentNames;
      // Reset agent counter so names start from the beginning of the new list
      localStorage.setItem('agentCount', '0');
    }
    if (result.pollInterval) restartPolling(result.pollInterval);
    statusEl.textContent = 'Saved';
    statusEl.className = 'settings-status success';
    setTimeout(() => closeSettings(), 800);
    // Re-fetch data to get updated projectDir
    fetchData();
  } catch (e) {
    statusEl.textContent = 'Network error';
    statusEl.className = 'settings-status error';
  }
}

async function fetchData() {
  try {
    const cacheBuster = Date.now();
    const response = await fetch('task-monitor-data.json?_=' + cacheBuster, { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed: ' + response.status);
    const data = await response.json();
    MONITOR_DATA = data;
    TASK_DATA = MONITOR_DATA.taskLists;
    fetchFailed = false;
    render();
  } catch (err) {
    fetchFailed = true;
    if (MONITOR_DATA && TASK_DATA.length > 0) render();
  }
}

function getNextAgentName() {
  const count = parseInt(localStorage.getItem('agentCount') || '0', 10);
  return count < AGENT_NAMES.length ? AGENT_NAMES[count] : 'agent-' + (count + 1);
}

function incrementAgentCount() {
  const count = parseInt(localStorage.getItem('agentCount') || '0', 10);
  localStorage.setItem('agentCount', String(count + 1));
}

function resetAgentCount() { localStorage.setItem('agentCount', '0'); render(); }

function getNextCodexName() {
  const count = parseInt(localStorage.getItem('codexCount') || '0', 10);
  return 'codex-' + (count < AGENT_NAMES.length ? AGENT_NAMES[count] : 'agent-' + (count + 1));
}

function incrementCodexCount() {
  const count = parseInt(localStorage.getItem('codexCount') || '0', 10);
  localStorage.setItem('codexCount', String(count + 1));
}

function resetCodexCount() { localStorage.setItem('codexCount', '0'); render(); }

function getCodeMode() {
  return localStorage.getItem('codeMode') || 'cda';
}

function setCodeMode(mode) {
  localStorage.setItem('codeMode', mode);
}

function showToast(message, command) {
  const toast = document.getElementById('toast');
  toast.innerHTML = message + '<code>' + escapeHtml(command) + '</code>';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

function switchTaskList(taskListId) {
  localStorage.setItem('selectedTaskList', taskListId);
  location.hash = taskListId;
  render();
}

function getSelectedListId() {
  if (location.hash && location.hash.length > 1) return decodeURIComponent(location.hash.slice(1));
  const stored = localStorage.getItem('selectedTaskList');
  if (stored) return stored;
  return TASK_DATA.length > 0 ? TASK_DATA[0].id : '';
}

function buildNextAvailableCommand(taskListId) {
  const projectDir = MONITOR_DATA.projectDir;
  return "cd " + projectDir + " && ./scripts/cda-agent.sh --task-list " + taskListId + " --agent $(tmux display-message -p '#S') -- --model opus";
}

function buildSpecificTaskCommand(taskListId, taskId) {
  return buildNextAvailableCommand(taskListId);
}

function launchSpecificTask(taskListId, taskId) {
  const command = buildSpecificTaskCommand(taskListId, taskId);
  const agentName = getNextAgentName();
  navigator.clipboard.writeText(command).then(() => {
    incrementAgentCount();
    showToast('Copied! Paste in a tmux session, then type /work ' + taskId + ' to start', command);
    render();
  }).catch(() => {
    console.log('Command: ' + command);
    showToast('Copy failed. See console (F12)', command);
    incrementAgentCount();
    render();
  });
}

function launchNextAvailable() {
  const taskListSelect = document.getElementById('task-list-select');
  const taskListId = taskListSelect ? taskListSelect.value : TASK_DATA[0].id;
  const command = buildNextAvailableCommand(taskListId);
  const agentName = getNextAgentName();
  navigator.clipboard.writeText(command).then(() => {
    incrementAgentCount();
    showToast('Copied! Paste in a tmux session to start agent', command);
    render();
  }).catch(() => {
    console.log('Command: ' + command);
    showToast('Copy failed. See console (F12)', command);
    incrementAgentCount();
    render();
  });
}

function buildReviewCommand(taskListId, taskId) {
  let cmd = "$codex-claude-review name=$(tmux display-message -p '#S') task-list=" + taskListId;
  if (taskId) cmd += ' task-id=' + taskId;
  return cmd;
}

function launchReview(taskListId, taskId) {
  const command = buildReviewCommand(taskListId, taskId);
  navigator.clipboard.writeText(command).then(() => {
    incrementCodexCount();
    const msg = taskId
      ? 'Codex review copied! Paste in a tmux session to start review on task #' + taskId
      : 'Codex review copied! Paste in a tmux session to start review';
    showToast(msg, command);
    render();
  }).catch(() => {
    console.log('Command: ' + command);
    showToast('Copy failed. See console (F12)', command);
    incrementCodexCount();
    render();
  });
}

function launchNextReview() {
  const taskListSelect = document.getElementById('task-list-select');
  const taskListId = taskListSelect ? taskListSelect.value : TASK_DATA[0].id;
  launchReview(taskListId, null);
}

function truncate(str, maxLen) { return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + '...'; }
function escapeHtml(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function getBlockerStatus(task, allTasks) {
  if (!task.blockedBy || task.blockedBy.length === 0) return { isBlocked: false, blockers: [], ready: false };
  const blockers = task.blockedBy.map(id => {
    const blocker = allTasks.find(t => t.id === id);
    return { id, done: blocker?.status === 'completed', subject: blocker?.subject || 'Unknown' };
  });
  const allDone = blockers.every(b => b.done);
  return { isBlocked: !allDone, blockers, ready: allDone && blockers.length > 0 };
}

function render() {
  if (!MONITOR_DATA || !TASK_DATA) return;
  const selectedId = getSelectedListId();
  let taskLists = TASK_DATA.filter(list => list.id === selectedId);
  if (taskLists.length === 0 && TASK_DATA.length > 0) {
    taskLists = [TASK_DATA[0]];
  }
  const totalTasks = taskLists.reduce((sum, list) => sum + list.tasks.length, 0);
  const inProgress = taskLists.reduce((sum, list) => sum + list.tasks.filter(t => t.status === 'in_progress').length, 0);
  const completed = taskLists.reduce((sum, list) => sum + list.tasks.filter(t => t.status === 'completed').length, 0);

  // Count available tasks (pending + not blocked)
  let available = 0;
  for (const list of taskLists) {
    for (const task of list.tasks) {
      if (task.status === 'pending') {
        const blockerStatus = getBlockerStatus(task, list.tasks);
        if (!blockerStatus.isBlocked) available++;
      }
    }
  }

  const agentMap = {};
  const unownedInProgress = [];
  for (const list of TASK_DATA) {
    for (const task of list.tasks) {
      if (task.status === 'in_progress') {
        if (task.owner) {
          if (!agentMap[task.owner]) agentMap[task.owner] = [];
          agentMap[task.owner].push({ ...task, listId: list.id });
        } else {
          unownedInProgress.push({ ...task, listId: list.id });
        }
      }
    }
  }
  const agentCount = Object.keys(agentMap).length + (unownedInProgress.length > 0 ? 1 : 0);

  const launchDiv = document.getElementById('launch');
  if (taskLists.length > 0) {
    const currentList = taskLists[0];
    const nextName = getNextAgentName();
    let taskListOptions = '';
    for (const list of MONITOR_DATA.availableLists) {
      const selected = list.id === currentList.id ? ' selected' : '';
      const label = truncate(list.id, 28) + ' (' + list.taskCount + ')';
      taskListOptions += '<option value="' + escapeHtml(list.id) + '"' + selected + '>' + escapeHtml(label) + '</option>';
    }
    const codeMode = getCodeMode();
    const codeDangerSel = codeMode === 'cda' ? ' selected' : '';
    const codeRegSel = codeMode === 'claude' ? ' selected' : '';
    const codexName = getNextCodexName();
    launchDiv.innerHTML = '<div class="control-bar">' +
      '<span class="title">Tasks</span><span class="divider"></span>' +
      '<select id="task-list-select" class="task-list-select" onchange="switchTaskList(this.value)">' + taskListOptions + '</select>' +
      '<select class="code-mode-select" onchange="setCodeMode(this.value)">' +
        '<option value="cda"' + codeDangerSel + '>Danger</option>' +
        '<option value="claude"' + codeRegSel + '>Reg</option>' +
      '</select>' +
      '<button class="launch-btn" onclick="launchNextAvailable()">Code</button>' +
      '<span class="agent-name">' + nextName + '</span>' +
      '<button class="reset-btn" onclick="resetAgentCount()">reset</button>' +
      '<span class="divider"></span>' +
      '<button class="review-btn" onclick="launchNextReview()">Review</button>' +
      '<span class="codex-name">' + codexName + '</span>' +
      '<button class="reset-btn" onclick="resetCodexCount()">reset</button>' +
      '<span class="spacer"></span>' +
      '<div class="stats"><span><span class="value available">' + available + '</span> avail</span><span><span class="value in-progress">' + inProgress + '</span> active</span><span><span class="value done">' + completed + '</span>/' + totalTasks + ' done</span></div>' +
      '<span class="divider"></span><button class="settings-btn" onclick="openSettings()">Settings</button>' +
    '</div>';
  } else {
    launchDiv.innerHTML = '<div class="control-bar"><span class="title">Tasks</span><span class="spacer"></span><button class="settings-btn" onclick="openSettings()">Settings</button></div>';
  }

  const agentsDiv = document.getElementById('agents');
  if (agentCount > 0 || unownedInProgress.length > 0) {
    let agentsHtml = '<div class="agents-bar"><span class="label">Working</span>';
    for (const [owner, tasks] of Object.entries(agentMap)) {
      for (const task of tasks) {
        const subject = task.activeForm || task.subject;
        agentsHtml += '<div class="agent"><span class="spinner"></span><span class="agent-owner">@' + escapeHtml(owner) + '</span><span class="agent-id">#' + task.id + '</span><span class="agent-task">' + escapeHtml(truncate(subject, 35)) + '</span></div>';
      }
    }
    for (const task of unownedInProgress) {
      const subject = task.activeForm || task.subject;
      agentsHtml += '<div class="agent"><span class="spinner"></span><span class="agent-id">#' + task.id + '</span><span class="agent-task">' + escapeHtml(truncate(subject, 40)) + '</span></div>';
    }
    agentsHtml += '</div>';
    agentsDiv.innerHTML = agentsHtml;
  } else {
    agentsDiv.innerHTML = '';
  }

  const content = document.getElementById('content');
  if (taskLists.length === 0) {
    agentsDiv.innerHTML = '';
    const projectDir = MONITOR_DATA.projectDir || '';
    const cdPrefix = projectDir ? 'cd ' + escapeHtml(projectDir) + ' && ' : '';
    content.innerHTML = '<div class="empty">No active task lists found.<code>' + cdPrefix + "./scripts/cda-agent.sh --task-list my-project --agent $(tmux display-message -p '#S') -- --model opus" + '</code></div>';
    document.getElementById('commands').innerHTML = '';
    return;
  }

  let html = '';
  for (const taskList of taskLists) {
    const pendingCount = taskList.tasks.filter(t => t.status === 'pending').length;
    const inProgressCount = taskList.tasks.filter(t => t.status === 'in_progress').length;
    const completedCount = taskList.tasks.filter(t => t.status === 'completed').length;
    const lastModified = new Date(taskList.lastModified).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    html += '<div class="task-list"><div class="task-list-header"><h2>' + escapeHtml(truncate(taskList.id, 24)) + '</h2><span class="meta">(' + taskList.tasks.length + ' tasks, updated ' + lastModified + ')</span></div>';
    const statusParts = [];
    if (inProgressCount > 0) statusParts.push('<span class="active">' + inProgressCount + ' active</span>');
    if (pendingCount > 0) statusParts.push('<span class="pending">' + pendingCount + ' pending</span>');
    if (completedCount > 0) statusParts.push('<span class="done">' + completedCount + ' done</span>');
    if (statusParts.length > 0) html += '<div class="status-summary">[' + statusParts.join(', ') + ']</div>';

    for (const task of taskList.tasks) {
      const blockerStatus = getBlockerStatus(task, taskList.tasks);
      const isAvailable = task.status === 'pending' && !blockerStatus.isBlocked;
      const icon = task.status === 'completed' ? '\\u25cf' : task.status === 'in_progress' ? '<span class="spinner"></span>' : isAvailable ? '\\u25c9' : '\\u25cb';
      const subject = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject;
      const suffixParts = [];
      if (task.owner && task.status !== 'pending') suffixParts.push('<span class="owner">@' + escapeHtml(task.owner) + '</span>');
      if (blockerStatus.isBlocked) {
        const blockerIds = blockerStatus.blockers.filter(b => !b.done).map(b => '#' + b.id).join(', ');
        suffixParts.push('<span class="blocked">waiting on ' + blockerIds + '</span>');
      }
      const canLaunch = isAvailable;
      const isReviewTask = task.subject.startsWith('REVIEW:');
      const taskClass = isAvailable ? 'task pending available'
        : blockerStatus.isBlocked ? 'task pending blocked'
        : 'task ' + task.status;
      let availableLabel = '';
      if (canLaunch) {
        if (isReviewTask) {
          availableLabel = '<span class="available-label" onclick="event.stopPropagation(); launchReview(\\'' + taskList.id + '\\', \\'' + task.id + '\\')">available</span>';
        } else {
          availableLabel = '<span class="available-label" onclick="event.stopPropagation(); launchSpecificTask(\\'' + taskList.id + '\\', \\'' + task.id + '\\')">available</span>';
        }
      }
      html += '<div class="' + taskClass + '"><span class="icon ' + task.status + '">' + icon + '</span><span class="id">#' + task.id + '</span><span class="subject">' + escapeHtml(truncate(subject, 50)) + '</span><span class="suffix">' + suffixParts.join('') + availableLabel + '</span></div>';
    }
    html += '</div>';
  }
  content.innerHTML = html;

  const commands = document.getElementById('commands');
  const mostRecent = taskLists[0];
  const projectDir = MONITOR_DATA.projectDir || '';
  const cdPrefix = projectDir ? 'cd ' + escapeHtml(projectDir) + ' && ' : '';
  let cmdHtml = '<h3>Quick Commands:</h3><div class="label"># Resume most recent task list:</div><code>' + cdPrefix + "./scripts/cda-agent.sh --task-list " + escapeHtml(mostRecent.id) + " --agent $(tmux display-message -p '#S') -- --model opus" + '</code>';
  if (taskLists.length > 1) {
    cmdHtml += '<div class="label"># Other task lists:</div>';
    for (const list of taskLists.slice(1, 4)) {
      cmdHtml += '<code class="dim">' + cdPrefix + "./scripts/cda-agent.sh --task-list " + escapeHtml(list.id) + " --agent $(tmux display-message -p '#S') -- --model opus" + '</code>';
    }
  }
  commands.innerHTML = cmdHtml;
}

// Initialize
loadSettings().then(() => {
  if (MONITOR_DATA) { render(); fetchData(); } else { fetchData(); }
  pollTimer = setInterval(() => { fetchData(); }, pollInterval);
});`;

// === Archive function ===
async function archiveTaskList(taskListId: string, tasks: ClaudeTask[]) {
  try {
    await fs.promises.mkdir(ARCHIVE_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(ARCHIVE_DIR, `${taskListId}_${timestamp}.json`);
    await fs.promises.writeFile(archivePath, JSON.stringify({
      id: taskListId,
      archivedAt: new Date().toISOString(),
      tasks
    }, null, 2));
    console.log(`[Archive] Saved ${taskListId} to ${archivePath}`);
  } catch (error) {
    console.error(`[Archive] Failed to archive ${taskListId}:`, error);
  }
}

// === Task file reading ===
function readTaskFile(filePath: string): ClaudeTask | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as ClaudeTask;
  } catch {
    return null;
  }
}

function getTaskLists(): ClaudeTaskList[] {
  const taskLists: ClaudeTaskList[] = [];

  if (!fs.existsSync(TASKS_DIR)) {
    return taskLists;
  }

  const listDirs = fs.readdirSync(TASKS_DIR, { withFileTypes: true });

  for (const dir of listDirs) {
    if (!dir.isDirectory() || dir.name === '.archive') continue;

    const listPath = path.join(TASKS_DIR, dir.name);
    const tasks: ClaudeTask[] = [];
    let lastModified = new Date(0);

    try {
      const taskFiles = fs.readdirSync(listPath);

      for (const file of taskFiles) {
        if (!file.endsWith(".json")) continue;

        const filePath = path.join(listPath, file);
        const task = readTaskFile(filePath);

        if (task) {
          tasks.push(task);
          const stat = fs.statSync(filePath);
          if (stat.mtime > lastModified) {
            lastModified = stat.mtime;
          }
        }
      }
    } catch {
      continue;
    }

    if (tasks.length > 0) {
      const sortedTasks = tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id));

      // Cache the task data for archiving when files are deleted
      taskDataCache.set(dir.name, { tasks: sortedTasks, lastModified });

      taskLists.push({
        id: dir.name,
        tasks: sortedTasks,
        lastModified,
      });
    }
  }

  return taskLists.sort(
    (a, b) => b.lastModified.getTime() - a.lastModified.getTime()
  );
}

function getAllTaskListSummaries(): TaskListSummary[] {
  const summaries: TaskListSummary[] = [];

  if (!fs.existsSync(TASKS_DIR)) {
    return summaries;
  }

  const listDirs = fs.readdirSync(TASKS_DIR, { withFileTypes: true });

  for (const dir of listDirs) {
    if (!dir.isDirectory() || dir.name === '.archive') continue;

    const listPath = path.join(TASKS_DIR, dir.name);
    const promptPath = path.join(listPath, 'prompt.md');
    const hasPrompt = fs.existsSync(promptPath);

    const tasks: ClaudeTask[] = [];
    let lastModified = new Date(0);

    try {
      const taskFiles = fs.readdirSync(listPath);

      for (const file of taskFiles) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(listPath, file);
        const task = readTaskFile(filePath);

        if (task) {
          tasks.push(task);
          const stat = fs.statSync(filePath);
          if (stat.mtime > lastModified) {
            lastModified = stat.mtime;
          }
        }
      }
    } catch {
      continue;
    }

    if (tasks.length > 0) {
      summaries.push({
        id: dir.name,
        path: listPath,
        taskCount: tasks.length,
        pendingCount: tasks.filter(t => t.status === 'pending').length,
        inProgressCount: tasks.filter(t => t.status === 'in_progress').length,
        completedCount: tasks.filter(t => t.status === 'completed').length,
        lastModified,
        hasPrompt
      });
    }
  }

  return summaries.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

// Debounce writeFiles to avoid rapid-fire regeneration from multiple file events
let writeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWriteFiles() {
  if (writeDebounceTimer) clearTimeout(writeDebounceTimer);
  writeDebounceTimer = setTimeout(() => {
    writeDebounceTimer = null;
    writeFiles();
  }, 300);
}

function writeFiles() {
  try {
    console.log(`[${new Date().toISOString()}] Regenerating monitor files...`);

    const taskLists = getTaskLists();
    const availableLists = getAllTaskListSummaries();
    const selectedListId = taskLists.length > 0 ? taskLists[0].id : '';
    const projectDir = currentConfig.projectDir;

    const monitorData: TaskMonitorData = {
      taskLists,
      availableLists,
      selectedListId,
      templates: [],
      projectDir
    };

    // Write JSON data file
    fs.writeFileSync(DATA_FILE, JSON.stringify(monitorData, null, 2));

    // Generate self-contained HTML with embedded CSS, JS, and data
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <title>Claude Tasks Monitor</title>
  <style>${CSS}</style>
</head>
<body>
  <div id="launch"></div>
  <div id="agents"></div>
  <div id="content"></div>
  <div id="toast" class="toast"></div>
  <div class="commands" id="commands"></div>
  <div class="footer">Real-time updates (polling every ${currentConfig.pollInterval / 1000}s)</div>
  <div id="settings-overlay" class="settings-overlay">
    <div class="settings-panel">
      <h2>Settings</h2>
      <div class="settings-field">
        <label for="settings-projectDir">Project Directory</label>
        <input type="text" id="settings-projectDir" placeholder="/path/to/project">
        <div class="hint">Working directory for launched agents</div>
      </div>
      <div class="settings-field">
        <label for="settings-pollInterval">Poll Interval (ms)</label>
        <input type="number" id="settings-pollInterval" min="500" max="60000" step="500" placeholder="2000">
        <div class="hint">How often the dashboard refreshes (500-60000ms)</div>
      </div>
      <div class="settings-field">
        <label for="settings-agentNames">Agent Names</label>
        <textarea id="settings-agentNames" placeholder="alpha, beta, gamma, ..."></textarea>
        <div class="hint">Comma-separated list of agent names for sequential assignment</div>
      </div>
      <div class="settings-actions">
        <button class="cancel-btn" onclick="closeSettings()">Cancel</button>
        <button class="save-btn" onclick="saveSettings()">Save</button>
      </div>
      <div id="settings-status" class="settings-status"></div>
    </div>
  </div>
  <script>window.__MONITOR_DATA__ = ${JSON.stringify(monitorData)};</script>
  <script>${JS}</script>
</body>
</html>`;

    fs.writeFileSync(HTML_FILE, htmlContent);

    console.log(`[${new Date().toISOString()}] Files regenerated successfully`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error regenerating files:`, error);
  }
}

// === Built-in HTTP Server ===
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function startHttpServer(): http.Server {
  const port = parseInt(process.env.CLAUDE_TASK_MONITOR_PORT || '8080', 10);

  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    const urlStr = req.url || '/';
    const parsedUrl = new URL(urlStr, `http://localhost:${port}`);
    const pathname = parsedUrl.pathname;

    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (pathname === '/api/config') {
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(currentConfig));
        return;
      }

      if (method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const input = JSON.parse(body);
            const result = validateConfig(input);
            if (!result.valid || !result.config) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: result.error }));
              return;
            }
            currentConfig = result.config;
            saveConfig(currentConfig);
            scheduleWriteFiles();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(currentConfig));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Static file serving
    let filePath: string;
    if (pathname === '/' || pathname === '/index.html') {
      filePath = HTML_FILE;
    } else {
      // Prevent directory traversal
      const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
      filePath = path.join(OUTPUT_DIR, safePath);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(OUTPUT_DIR))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(data);
    });
  });

  server.listen(port, () => {
    console.log(`[HTTP] Server listening on http://localhost:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[HTTP] Port ${port} is already in use. Set CLAUDE_TASK_MONITOR_PORT to use a different port.`);
    } else {
      console.error(`[HTTP] Server error:`, err);
    }
  });

  return server;
}

function migrateOldConfig(): void {
  const oldConfigPath = path.join(__dirname, '..', 'monitor-config.json');
  try {
    if (fs.existsSync(oldConfigPath) && !fs.existsSync(CONFIG_FILE)) {
      fs.copyFileSync(oldConfigPath, CONFIG_FILE);
      console.log(`[Migration] Copied config from ${oldConfigPath} → ${CONFIG_FILE}`);
    }
  } catch (err) {
    console.error('[Migration] Failed to migrate old config:', err);
  }
}

function printHelp(): void {
  console.log(`
Claude Task Monitor v2.2.1

Usage:
  claude-task-monitor              Start the monitor dashboard
  claude-task-monitor --help       Show this help message
  claude-task-monitor --install-skill  Install the Claude Code skill

Environment Variables:
  CLAUDE_TASK_MONITOR_DATA_DIR   Data directory (default: ~/.claude/claude-task-monitor/)
  CLAUDE_TASK_MONITOR_OUTPUT     Output directory for HTML/JSON (default: same as data dir)
  CLAUDE_TASK_MONITOR_PORT       HTTP server port (default: 8080)

File Locations:
  Config:     ~/.claude/claude-task-monitor/monitor-config.json
  Data:       ~/.claude/claude-task-monitor/task-monitor-data.json
  Dashboard:  ~/.claude/claude-task-monitor/task-monitor.html
  Tasks:      ~/.claude/tasks/
  Archives:   ~/.claude/tasks/.archive/

Homepage: https://github.com/gilbertdelbosco/claude-task-monitor
`);
}

function installSkill(): void {
  const skillSource = path.join(__dirname, '..', 'skill', 'SKILL.md');
  const skillDestDir = path.join(os.homedir(), '.claude', 'skills', 'task-monitor');
  const skillDest = path.join(skillDestDir, 'SKILL.md');

  if (!fs.existsSync(skillSource)) {
    console.error(`[Skill] Skill file not found at ${skillSource}`);
    process.exit(1);
  }

  fs.mkdirSync(skillDestDir, { recursive: true });
  fs.copyFileSync(skillSource, skillDest);
  console.log(`[Skill] Installed skill to ${skillDest}`);
}

function main() {
  // Parse CLI flags
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  if (args.includes('--install-skill')) {
    installSkill();
    process.exit(0);
  }

  // Ensure DATA_DIR exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Migrate old config from project directory
  migrateOldConfig();

  // Load config (create default if missing)
  currentConfig = loadConfig();
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(currentConfig);
    console.log(`[Config] Created default config at ${CONFIG_FILE}`);
  }

  const port = parseInt(process.env.CLAUDE_TASK_MONITOR_PORT || '8080', 10);

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           Claude Task Monitor v2.2.1                      ║
╚═══════════════════════════════════════════════════════════╝
`);

  // Ensure tasks directory exists
  if (!fs.existsSync(TASKS_DIR)) {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  // Initial write
  writeFiles();

  // Start HTTP server
  const httpServer = startHttpServer();

  console.log(`\nDashboard: http://localhost:${port}/`);
  console.log(`Data dir:  ${DATA_DIR}`);
  console.log(`Config:    ${CONFIG_FILE}`);
  console.log(`Project:   ${currentConfig.projectDir}`);
  console.log(`\nFeatures:`);
  console.log(`  - Built-in HTTP server (port ${port})`);
  console.log(`  - Real-time updates (polling every ${currentConfig.pollInterval / 1000}s)`);
  console.log(`  - Settings panel in dashboard`);
  console.log(`  - Archives completed task lists to ~/.claude/tasks/.archive/`);
  console.log(`  - Launch agents with one click`);
  console.log(`\nTip: Run 'claude-task-monitor --install-skill' to add the Claude Code skill.`);
  console.log(`\nWatching for changes... (Ctrl+C to exit)\n`);

  // Set up file watcher for tasks
  const taskWatcher = chokidar.watch(TASKS_DIR, {
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 100,
    binaryInterval: 100,
    depth: 99,
  });

  taskWatcher
    .on("ready", () => {
      console.log(`[Watcher] Ready and watching: ${TASKS_DIR}`);
    })
    .on("add", (filePath) => {
      if (!filePath.endsWith('.json') || filePath.includes('.archive')) return;
      console.log(`[Watcher] File added: ${filePath}`);
      scheduleWriteFiles();
    })
    .on("change", (filePath) => {
      if (!filePath.endsWith('.json') || filePath.includes('.archive')) return;
      console.log(`[Watcher] File changed: ${filePath}`);
      scheduleWriteFiles();
    })
    .on("unlink", (filePath) => {
      if (!filePath.endsWith('.json') || filePath.includes('.archive')) return;

      // Archive the task list before it's gone
      const taskListId = path.basename(path.dirname(filePath));
      const cachedData = taskDataCache.get(taskListId);
      if (cachedData && cachedData.tasks.length > 0) {
        archiveTaskList(taskListId, cachedData.tasks).catch((err) => {
          console.error(`[Archive] Error archiving ${taskListId}:`, err);
        });
        taskDataCache.delete(taskListId);
      }

      console.log(`[Watcher] File removed: ${filePath}`);
      scheduleWriteFiles();
    })
    .on("error", (error) => {
      console.error(`[Watcher] Error: ${error}`);
    });

  // Watch config file for external edits
  const configWatcher = chokidar.watch(CONFIG_FILE, {
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 500,
  });

  configWatcher.on("change", () => {
    console.log(`[Config] Config file changed externally, reloading...`);
    const newConfig = loadConfig();
    currentConfig = newConfig;
    console.log(`[Config] Reloaded: projectDir=${currentConfig.projectDir}, pollInterval=${currentConfig.pollInterval}`);
    scheduleWriteFiles();
  });

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nGoodbye!");
    taskWatcher.close();
    configWatcher.close();
    httpServer.close();
    process.exit(0);
  });

  // Prevent crashes from unhandled errors
  process.on("uncaughtException", (error) => {
    console.error(`[${new Date().toISOString()}] Uncaught exception (recovered):`, error);
  });

  process.on("unhandledRejection", (reason) => {
    console.error(`[${new Date().toISOString()}] Unhandled rejection (recovered):`, reason);
  });
}

main();
