import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';

const board = document.querySelector('#board');
const dialog = document.querySelector('#task-dialog');
const detailsDialog = document.querySelector('#details-dialog');
const form = document.querySelector('#task-form');
const attachmentInput = document.querySelector('#task-attachments');
const attachmentList = document.querySelector('#attachment-list');
const editAttachmentInput = document.querySelector('#edit-attachments');
const editAttachmentList = document.querySelector('#edit-attachment-list');
const maxAttachmentBytes = 30 * 1024 * 1024;
const names = { backlog: 'Backlog', todo: 'To do', 'in-progress': 'In progress', review: 'Review', done: 'Done' };
const descriptions = { backlog: 'Ideas and upcoming work', todo: 'Ready to be picked up', 'in-progress': 'Work in motion', review: 'Agent finished; ready for review', done: 'Nicely wrapped up' };
let tasks = [];
let selectedTaskId = null;
let pendingEditFiles = [];
let editUploadInProgress = false;
let terminalInstance = null;
let terminalFit = null;
let terminalSocket = null;
let terminalObserver = null;
let terminalReconnectTimer = null;
let terminalRetryDelay = 1000;
let hasLoadedTasks = false;
let agentKinds = [];
let agentOptionsLoaded = false;
const nativeWorktreeAgents = new Set(['codex']);
let models = [
  { slug: 'default', displayName: 'Default', efforts: [] },
  ...['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'].map((slug) => ({ slug, displayName: slug, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] })),
];
function fillDropdowns(selector, values, labels = {}) {
  document.querySelectorAll(selector).forEach((select) => {
    const selected = select.value;
    select.innerHTML = values.map(({ value, label }) => `<option value="${escapeHtml(value)}">${escapeHtml(label || labels[value] || value)}</option>`).join('');
    if (values.some(({ value }) => value === selected)) select.value = selected;
  });
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function syncEfforts(formElement, preferred = 'default') {
  const modelId = formElement.elements.model.value;
  const effortOptions = modelId === 'default' ? [] : (models.find((model) => model.slug === modelId)?.efforts || []);
  const values = [{ value: 'default', label: 'Default' }, ...effortOptions.map((value) => ({ value, label: value }))];
  const effort = formElement.elements.effort;
  fillDropdowns(`#${formElement.id} .effort-options`, values);
  effort.value = values.some((option) => option.value === preferred) ? preferred : 'default';
}
function initializeOptionDropdowns() {
  const agentOptions = agentKinds.length
    ? agentKinds.map((value) => ({ value, label: value === 'codex' ? 'Codex' : value }))
    : [{ value: '', label: agentOptionsLoaded ? 'No supported agents available' : 'Loading supported agents…' }];
  fillDropdowns('.agent-options', agentOptions);
  document.querySelectorAll('.agent-options').forEach((select) => { select.disabled = !agentKinds.length; });
  document.querySelector('#submit-task').disabled = !agentKinds.length;
  document.querySelector('#new-task').disabled = !agentKinds.length;
  fillDropdowns('.model-options', models.map((model) => ({ value: model.slug, label: model.displayName })));
  for (const select of document.querySelectorAll('.model-options')) {
    const formElement = select.closest('form');
    select.addEventListener('change', () => syncEfforts(formElement));
  }
  const taskAgentSelect = document.querySelector('#task-form .agent-options');
  taskAgentSelect.onchange = syncWorktreeOption;
  syncWorktreeOption();
  const editAgentSelect = document.querySelector('#edit-task-form .agent-options');
  editAgentSelect.onchange = () => syncEditWorktreeOption();
  syncEditWorktreeOption();
  for (const formElement of document.querySelectorAll('#task-form, #edit-task-form')) syncEfforts(formElement, formElement.elements.effort.value || 'default');
}
function syncWorktreeOption() {
  const checkbox = form.elements.runInWorktree;
  const label = checkbox.closest('.checkbox-label');
  const supported = nativeWorktreeAgents.has(form.elements.agentKind.value);
  label.hidden = !supported;
  checkbox.checked = supported;
}
function syncEditWorktreeOption(loadTaskValue = false) {
  const editForm = document.querySelector('#edit-task-form');
  const checkbox = editForm.elements.runInWorktree;
  const label = checkbox.closest('.checkbox-label');
  const task = tasks.find((item) => item.id === selectedTaskId);
  const supported = nativeWorktreeAgents.has(editForm.elements.agentKind.value);
  label.hidden = !supported;
  checkbox.disabled = Boolean(task?.launch);
  if (!supported) checkbox.checked = false;
  else if (loadTaskValue) checkbox.checked = Boolean(task?.runInWorktree);
}
async function loadOptions() {
  try {
    const result = await request('/api/options');
    agentKinds = Array.isArray(result.agentKinds) ? result.agentKinds : [];
    agentOptionsLoaded = true;
    if (result.models?.length) models = [{ slug: 'default', displayName: 'Default', efforts: [] }, ...result.models];
    initializeOptionDropdowns();
    const agentWarning = result.warnings?.find((warning) => warning.startsWith('Agent kinds are unavailable:'));
    const warningElement = document.querySelector('#agent-warning');
    warningElement.textContent = agentWarning || '';
    warningElement.hidden = !agentWarning;
    if (result.warnings?.length) {
      for (const select of document.querySelectorAll('.agent-options, .model-options, .effort-options')) select.title = result.warnings.join(' ');
    }
  } catch {
    agentOptionsLoaded = true;
    initializeOptionDropdowns();
    const warningElement = document.querySelector('#agent-warning');
    warningElement.textContent = 'Supported agents could not be loaded. Check the Herdr CLI and reload the dashboard.';
    warningElement.hidden = false;
  }
}
initializeOptionDropdowns();

const notificationToggle = document.querySelector('#notification-toggle');
function updateNotificationToggle() {
  if (!('Notification' in window)) {
    notificationToggle.textContent = 'Notifications unavailable';
    notificationToggle.disabled = true;
    notificationToggle.title = 'This browser does not support notifications';
    return;
  }
  const enabled = Notification.permission === 'granted';
  notificationToggle.textContent = enabled ? 'Notifications on' : 'Enable notifications';
  notificationToggle.setAttribute('aria-pressed', String(enabled));
  notificationToggle.disabled = enabled || Notification.permission === 'denied';
  notificationToggle.title = Notification.permission === 'denied'
    ? 'Notifications are blocked in browser settings'
    : 'Show a browser notification when a task status changes';
}
updateNotificationToggle();
notificationToggle.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  try {
    await Notification.requestPermission();
    updateNotificationToggle();
  } catch { updateNotificationToggle(); }
});

function notifyTaskStatusChanges(nextTasks) {
  const previousById = new Map(tasks.map((task) => [task.id, task]));
  if (hasLoadedTasks && 'Notification' in window && Notification.permission === 'granted') {
    for (const task of nextTasks) {
      const previous = previousById.get(task.id);
      if (previous && previous.status !== task.status) {
        const body = task.status === 'review'
          ? 'Ready for review'
          : `Status: ${names[task.status] || task.status}`;
        new Notification(task.title, { body });
      }
    }
  }
  tasks = nextTasks;
  hasLoadedTasks = true;
}

const themeToggle = document.querySelector('#theme-toggle');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  themeToggle.textContent = dark ? '☀' : '☾';
  themeToggle.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
  themeToggle.title = `Switch to ${dark ? 'light' : 'dark'} theme`;
  document.querySelector('meta[name="theme-color"]').content = dark ? '#171b24' : '#f6f7f9';
}
const savedTheme = localStorage.getItem('herdr-theme');
setTheme(savedTheme === 'dark' ? 'dark' : 'light');
themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('herdr-theme', theme);
  setTheme(theme);
});

async function request(url, options) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options?.headers || {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}

function render() {
  const completed = tasks.filter((task) => task.status === 'done').length;
  const active = tasks.filter((task) => task.status === 'in-progress').length;
  document.querySelector('#total-count').textContent = tasks.length;
  document.querySelector('#active-count').textContent = active;
  document.querySelector('#progress-label').textContent = `${tasks.length ? Math.round(completed / tasks.length * 100) : 0}%`;
  document.querySelector('#progress-fill').style.width = document.querySelector('#progress-label').textContent;
  board.innerHTML = Object.entries(names).map(([status, name]) => {
    const cards = tasks.filter((task) => task.status === status);
    return `<section class="column" data-status="${status}"><div class="column-head"><div><span class="column-dot ${status}"></span><h2>${name}</h2><span class="count">${String(cards.length).padStart(2, '0')}</span></div><button class="add-card" data-add="${status}" aria-label="Add task to ${name}">＋</button></div><p class="column-hint">${descriptions[status]}</p><div class="card-list" data-drop="${status}">${cards.map(cardMarkup).join('')}${cards.length ? '' : `<div class="empty-state"><span class="empty-icon">${status === 'done' ? '✓' : '✳'}</span><span>${status === 'backlog' ? 'A fresh start.' : status === 'done' ? 'Nothing here yet.' : 'Ready for a card.'}</span></div>`}</div></section>`;
  }).join('');
  board.querySelectorAll('[data-add]').forEach((button) => {
    button.disabled = !agentKinds.length;
    button.title = agentKinds.length ? `Add task to ${names[button.dataset.add]}` : 'No supported agents are available';
    button.addEventListener('click', () => openForm(button.dataset.add));
  });
  board.querySelectorAll('[data-card-menu]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = button.nextElementSibling;
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  }));
  board.querySelectorAll('[data-close-tab]').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    await request(`/api/tasks/${button.dataset.closeTab}/tab`, { method: 'DELETE' });
    await refresh();
  }));
  board.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async (event) => { event.stopPropagation(); if (confirm('Delete this task?')) { await request(`/api/tasks/${button.dataset.delete}`, { method: 'DELETE' }); await refresh(); } }));
  board.querySelectorAll('[data-open-tab]').forEach((button) => button.addEventListener('click', async (event) => {
    event.stopPropagation();
    try { await request(`/api/tasks/${button.dataset.openTab}/focus`, { method: 'POST' }); await refresh(); }
    catch (error) { window.alert(`Could not open the Herdr tab: ${error.message}`); }
  }));
  board.querySelectorAll('.task-card').forEach((card) => {
    card.addEventListener('click', () => openDetails(card.dataset.id));
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetails(card.dataset.id); } });
    card.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', card.dataset.id); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  board.querySelectorAll('[data-drop]').forEach((zone) => {
    zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', async (event) => { event.preventDefault(); zone.classList.remove('over'); const id = event.dataTransfer.getData('text/plain'); const task = await request(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: zone.dataset.drop }) }); if (task.launchError) window.alert(`Task moved to To do, but Codex could not be started: ${task.launchError}`); await refresh(); });
  });
}

function cardMarkup(task) {
  const date = new Date(task.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const safe = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const tabOpen = task.herdrTabOpen;
  const attachments = task.attachments || [];
  const readiness = task.mergeReadiness;
  const branch = task.launch?.worktree?.branch;
  const branchLabel = branch ? `<p class="task-branch" title="${safe(branch)}">Branch: ${safe(branch)}</p>` : '';
  const mergeStatus = branch ? `<p class="merge-readiness ${safe(readiness?.status || 'pending')}" title="${safe(task.mergeProblem || readiness?.message || 'Merge status pending.')}">${safe(task.mergeProblem ? task.mergeProblem : readiness?.status === 'safe' || readiness?.status === 'merged' ? readiness.message : readiness?.status === 'problem' ? readiness.message : 'Merge status pending')}</p>` : '';
  return `<article class="task-card" draggable="true" tabindex="0" data-id="${safe(task.id)}"><div class="card-top"><span class="priority ${safe(task.priority)}"><i></i>${safe(task.priority)}</span><button class="task-state ${tabOpen ? 'running' : 'stopped'}" data-open-tab="${safe(task.id)}" title="${tabOpen ? 'Herdr tab open — click to focus' : 'No Herdr tab — click to open'}" aria-label="${tabOpen ? 'Focus open Herdr tab' : 'Open Herdr tab'}">●</button><div class="card-menu-wrap"><button class="delete-card" data-card-menu aria-expanded="false" title="Card options" aria-label="Card options">···</button><div class="card-menu" hidden><button data-close-tab="${safe(task.id)}">Close Herdr tab</button><button data-delete="${safe(task.id)}">Delete card</button></div></div></div><h3>${safe(task.title)}</h3>${task.description ? `<p class="card-description">${safe(task.description)}</p>` : ''}${attachments.length ? `<p class="card-attachments" title="${attachments.map((file) => safe(file.name)).join(', ')}">📎 ${attachments.map((file) => safe(file.name)).join(', ')}</p>` : ''}${branchLabel}${mergeStatus}<div class="card-bottom"><span class="task-date"><span>◷</span> ${date}</span><span class="avatar">${safe(task.title.trim().slice(0, 1).toUpperCase())}</span></div></article>`;
}

async function refresh() { notifyTaskStatusChanges(await request('/api/tasks')); render(); }
function renderEditAttachments() {
  const task = tasks.find((item) => item.id === selectedTaskId);
  const savedFiles = task?.attachments || [];
  const total = savedFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
    + pendingEditFiles.reduce((sum, file) => sum + file.size, 0);
  const names = [
    ...savedFiles.map((file) => file.name),
    ...pendingEditFiles.map((file) => `+ ${file.name}`),
  ];
  editAttachmentList.textContent = names.length
    ? `${names.join('\n')}\n${(total / 1024 / 1024).toFixed(2)} MiB of 30 MiB`
    : 'No files attached';
  editAttachmentList.dataset.overLimit = String(total > maxAttachmentBytes);
}
function addEditFiles(files) {
  const incoming = [...files].filter((file) => file instanceof File);
  const currentTask = tasks.find((task) => task.id === selectedTaskId);
  const savedBytes = (currentTask?.attachments || []).reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const pendingBytes = pendingEditFiles.reduce((sum, file) => sum + file.size, 0);
  const incomingBytes = incoming.reduce((sum, file) => sum + file.size, 0);
  if (savedBytes + pendingBytes + incomingBytes > maxAttachmentBytes) {
    window.alert('Attachments for this task must total 30 MiB or less.');
    return;
  }
  pendingEditFiles.push(...incoming);
  renderEditAttachments();
  void uploadPendingEditFiles();
}
async function uploadPendingEditFiles() {
  if (!pendingEditFiles.length) return true;
  if (editUploadInProgress) return false;
  const files = [...pendingEditFiles];
  const taskId = selectedTaskId;
  if (!taskId) return false;
  let uploaded = false;
  editUploadInProgress = true;
  const saveButton = document.querySelector('#edit-task-form button[type="submit"]');
  saveButton.disabled = true;
  try {
    const attachments = await Promise.all(files.map(async (file) => ({ name: file.name, data: await fileAsBase64(file) })));
    const result = await request(`/api/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ attachments }) });
    pendingEditFiles = pendingEditFiles.filter((file) => !files.includes(file));
    uploaded = true;
    await refresh();
    renderEditAttachments();
    if (result.attachmentPromptError) window.alert(`Files were saved, but could not be sent to the running agent: ${result.attachmentPromptError}`);
    return true;
  } catch (error) {
    window.alert(`Could not upload files: ${error.message}`);
    return false;
  } finally {
    editUploadInProgress = false;
    saveButton.disabled = false;
    if (uploaded && pendingEditFiles.length && selectedTaskId === taskId) void uploadPendingEditFiles();
  }
}
async function openDetails(id) {
  selectedTaskId = id;
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  document.querySelector('#details-title').textContent = task.title;
  document.querySelector('#details-description').textContent = task.description || 'No description provided.';
  const editForm = document.querySelector('#edit-task-form');
  pendingEditFiles = [];
  editAttachmentInput.value = '';
  for (const key of ['title', 'description', 'priority', 'agentKind', 'model']) {
    editForm.elements[key].value = task[key] || (key === 'agentKind' ? 'codex' : key === 'priority' ? 'medium' : 'default');
  }
  syncEditWorktreeOption(true);
  syncEfforts(editForm, task.effort || 'default');
  const running = task.agentState === 'working';
  for (const key of ['agentKind', 'model', 'effort']) editForm.elements[key].disabled = running;
  document.querySelector('#agent-lock-note').hidden = !running;
  renderEditAttachments();
  const focusButton = document.querySelector('#focus-tab');
  focusButton.disabled = false;
  focusButton.textContent = task.herdrTabOpen ? 'Focus Herdr tab ↗' : 'Open Herdr tab ↗';
  renderTaskMergeAction(task);
  detailsDialog.showModal();
  startTaskTerminal(task.id);
}
function renderTaskMergeAction(task) {
  const button = document.querySelector('#merge-task');
  const status = document.querySelector('#merge-task-status');
  const readiness = task?.mergeReadiness;
  const available = Boolean(task?.runInWorktree && readiness?.status === 'safe');
  button.hidden = !available;
  status.hidden = !task?.runInWorktree || !readiness || available;
  status.className = `merge-readiness ${escapeHtml(readiness?.status || 'pending')}`;
  status.textContent = task?.mergeProblem || readiness?.message || '';
}
function terminalStatus(text, state = 'connecting') {
  document.querySelector('#terminal-updated').textContent = text;
  document.querySelector('#terminal-indicator').dataset.state = state;
}
function stopTaskTerminal() {
  clearTimeout(terminalReconnectTimer);
  terminalReconnectTimer = null;
  terminalObserver?.disconnect();
  terminalObserver = null;
  if (terminalSocket) {
    terminalSocket.onclose = null;
    terminalSocket.close();
    terminalSocket = null;
  }
  terminalInstance?.dispose();
  terminalInstance = null;
  terminalFit = null;
}
function startTaskTerminal(taskId) {
  stopTaskTerminal();
  terminalRetryDelay = 1000;
  const container = document.querySelector('#terminal-output');
  container.replaceChildren();
  terminalInstance = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 12,
    scrollback: 1000,
    theme: { background: '#171c24', foreground: '#d5dbe4', cursor: '#d5dbe4', selectionBackground: '#5267de88' },
  });
  terminalFit = new FitAddon();
  terminalInstance.loadAddon(terminalFit);
  terminalInstance.open(container);
  terminalFit.fit();
  terminalObserver = new ResizeObserver(() => terminalFit?.fit());
  terminalObserver.observe(container);
  terminalInstance.onData((data) => {
    if (terminalSocket?.readyState === WebSocket.OPEN) terminalSocket.send(JSON.stringify({ type: 'input', data }));
  });
  connectTaskTerminal(taskId);
}
function connectTaskTerminal(taskId) {
  if (!detailsDialog.open || selectedTaskId !== taskId || !terminalInstance) return;
  terminalStatus('Connecting to Herdr pane…');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/tasks/${encodeURIComponent(taskId)}/terminal`);
  terminalSocket = socket;
  let hasSnapshot = false;
  let hasConnectionMessage = false;
  socket.addEventListener('open', () => {
    terminalRetryDelay = 1000;
    terminalStatus('Connected · waiting for pane output', 'connected');
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'snapshot' && typeof message.text === 'string') {
      hasSnapshot = true;
      terminalInstance?.reset();
      terminalInstance?.write(message.text || '\x1b[90m(No pane output yet.)\x1b[0m');
      terminalStatus(`Connected · updated ${new Date().toLocaleTimeString()}`, 'connected');
      terminalFit?.fit();
    } else if (message.type === 'error') {
      hasConnectionMessage = true;
      terminalStatus(message.message, 'error');
      terminalInstance?.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
    }
  });
  socket.addEventListener('close', (event) => {
    if (terminalSocket !== socket) return;
    terminalSocket = null;
    if (event.code === 1008) {
      if (!hasConnectionMessage) {
        terminalStatus(event.reason || 'This task has no Herdr pane yet.', 'error');
        terminalInstance?.writeln(`\r\n\x1b[31m${event.reason || 'This task has no Herdr pane yet.'}\x1b[0m`);
      }
      return;
    }
    terminalStatus(hasSnapshot ? 'Connection lost · reconnecting…' : 'Could not connect · reconnecting…', 'error');
    if (detailsDialog.open && selectedTaskId === taskId) {
      terminalReconnectTimer = setTimeout(() => connectTaskTerminal(taskId), terminalRetryDelay);
      terminalRetryDelay = Math.min(terminalRetryDelay * 2, 10_000);
    }
  });
  socket.addEventListener('error', () => terminalStatus('Terminal connection error', 'error'));
}
document.querySelector('#close-details').addEventListener('click', () => detailsDialog.close());
detailsDialog.addEventListener('close', () => { stopTaskTerminal(); selectedTaskId = null; });
document.querySelector('#focus-tab').addEventListener('click', async () => {
  if (!selectedTaskId) return;
  try { await request(`/api/tasks/${selectedTaskId}/focus`, { method: 'POST' }); await refresh(); }
  catch (error) { window.alert(`Could not focus the task tab: ${error.message}`); }
});
document.querySelector('#merge-task').addEventListener('click', async () => {
  if (!selectedTaskId) return;
  const button = document.querySelector('#merge-task');
  button.disabled = true;
  try {
    await request(`/api/tasks/${selectedTaskId}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    await refresh();
    const task = tasks.find((item) => item.id === selectedTaskId);
    if (task) renderTaskMergeAction(task);
  } catch (error) {
    window.alert(`Could not merge task: ${error.message}`);
  } finally { button.disabled = false; }
});
document.querySelector('#edit-task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedTaskId) return;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  values.runInWorktree = event.currentTarget.elements.runInWorktree.checked;
  try {
    if (!await uploadPendingEditFiles()) return;
    const result = await request(`/api/tasks/${selectedTaskId}`, { method: 'PATCH', body: JSON.stringify(values) });
    await refresh();
    const updated = tasks.find((task) => task.id === selectedTaskId);
    if (updated) {
      document.querySelector('#details-title').textContent = updated.title;
      document.querySelector('#details-description').textContent = updated.description || 'No description provided.';
    }
    renderEditAttachments();
    if (result.attachmentPromptError) window.alert(`Files were saved, but could not be sent to the running agent: ${result.attachmentPromptError}`);
  } catch (error) { window.alert(`Could not save task: ${error.message}`); }
});
editAttachmentInput.addEventListener('change', () => {
  addEditFiles(editAttachmentInput.files);
  editAttachmentInput.value = '';
});
detailsDialog.addEventListener('dragenter', (event) => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  document.querySelector('.details-shell').classList.add('file-drop-active');
});
detailsDialog.addEventListener('dragover', (event) => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
detailsDialog.addEventListener('dragleave', (event) => {
  if (event.target === detailsDialog) document.querySelector('.details-shell').classList.remove('file-drop-active');
});
detailsDialog.addEventListener('drop', (event) => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  event.preventDefault();
  document.querySelector('.details-shell').classList.remove('file-drop-active');
  addEditFiles(event.dataTransfer.files);
});
setInterval(() => refresh().catch(() => {}), 2200);
function openForm(status = 'backlog') { if (!agentKinds.length) return; dialog.dataset.status = status; form.reset(); syncWorktreeOption(); attachmentList.textContent = 'No files attached'; attachmentList.dataset.overLimit = 'false'; syncEfforts(form); dialog.showModal(); setTimeout(() => form.elements.title.focus(), 0); }
document.querySelector('#new-task').addEventListener('click', () => openForm());
attachmentInput.addEventListener('change', () => {
  const files = [...attachmentInput.files];
  const total = files.reduce((sum, file) => sum + file.size, 0);
  attachmentList.textContent = files.length
    ? `${files.map((file) => file.name).join('\n')}\n${(total / 1024 / 1024).toFixed(2)} MiB of 30 MiB`
    : 'No files attached';
  attachmentList.dataset.overLimit = String(total > maxAttachmentBytes);
});
async function fileAsBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!agentKinds.length) return;
  const files = [...attachmentInput.files];
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > maxAttachmentBytes) {
    window.alert('Attachments must total 30 MiB or less.');
    return;
  }
  const values = Object.fromEntries(new FormData(form));
  values.runInWorktree = form.elements.runInWorktree.checked;
  values.status = dialog.dataset.status || 'backlog';
  const submitButton = document.querySelector('#submit-task');
  submitButton.disabled = true;
  try {
    values.attachments = await Promise.all(files.map(async (file) => ({ name: file.name, data: await fileAsBase64(file) })));
    const task = await request('/api/tasks', { method: 'POST', body: JSON.stringify(values) });
    if (task.launchError) window.alert(`Task saved, but Codex could not be started: ${task.launchError}`);
    dialog.close(); await refresh();
  } catch (error) { window.alert(`Could not create task: ${error.message}`); }
  finally { submitButton.disabled = !agentKinds.length; }
});
loadOptions();
refresh().catch((error) => { board.innerHTML = `<p class="error">Could not load tasks: ${error.message}</p>`; });
