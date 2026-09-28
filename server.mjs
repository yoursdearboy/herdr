import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.HERDR_PLUGIN_STATE_DIR || path.join(root, '.herdr-kanban');
const dataFile = path.join(dataDir, 'tasks.json');
const maxAttachmentBytes = 30 * 1024 * 1024;
const maxTaskRequestBytes = 45 * 1024 * 1024;
const columns = ['backlog', 'todo', 'in-progress', 'review', 'done'];
const nativeWorktreeAgents = new Set(['codex']);
const fallbackModels = ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'];
const fallbackEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh'];
let optionsCache;
let optionsCacheAt = 0;

function inspectOptions() {
  const warnings = [];
  let agentKinds = [];
  let models = fallbackModels.map((slug) => ({ slug, displayName: slug, efforts: fallbackEfforts }));
  try {
    const help = spawnSync(process.env.HERDR_BIN_PATH || 'herdr', ['agent', 'start', '--help'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000 });
    if (help.error || help.status !== 0) throw new Error(help.error?.message || help.stderr?.trim() || 'Herdr help returned an error.');
    const match = `${help.stdout}\n${help.stderr}`.match(/possible values:\s*([^\n]+)/i);
    if (!match) throw new Error('Could not find supported agent kinds in Herdr help.');
    const advertisedKinds = match[1].split(',').map((value) => value.trim()).filter(Boolean);
    if (!advertisedKinds.length) throw new Error('Herdr returned no supported agent kinds.');
    const integrations = spawnSync(process.env.HERDR_BIN_PATH || 'herdr', ['integration', 'status'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000 });
    if (integrations.error || integrations.status !== 0) throw new Error(integrations.error?.message || integrations.stderr?.trim() || 'Herdr integration status returned an error.');
    const installedKinds = new Set();
    for (const line of integrations.stdout.split(/\r?\n/)) {
      const status = line.match(/^([a-z0-9-]+)(?: \(experimental\))?:\s*(.*)$/i);
      if (!status || /^not installed\b/i.test(status[2])) continue;
      installedKinds.add(status[1] === 'antigravity-cli' ? 'gemini' : status[1]);
    }
    agentKinds = advertisedKinds.filter((kind) => installedKinds.has(kind));
    if (!agentKinds.length) throw new Error('Herdr has no installed agent integrations.');
  } catch (error) { warnings.push(`Agent kinds are unavailable: ${error.message}`); }
  try {
    const result = spawnSync(process.env.CODEX_BIN_PATH || 'codex', ['debug', 'models'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 10_000_000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || 'Codex model introspection returned an error.');
    const catalog = JSON.parse(result.stdout);
    const discovered = (catalog.models || []).filter((model) => model.visibility === 'list').map((model) => ({
      slug: model.slug,
      displayName: model.display_name || model.slug,
      efforts: [...new Set((model.supported_reasoning_levels || []).map((level) => level.effort).filter(Boolean))],
    })).filter((model) => model.slug && model.efforts.length);
    if (!discovered.length) throw new Error('Codex returned no visible models with reasoning levels.');
    models = discovered;
  } catch (error) { warnings.push(`Models and effort levels are using fallback values: ${error.message}`); }
  return { agentKinds, models, warnings };
}

function getOptions() {
  if (!optionsCache || Date.now() - optionsCacheAt > 60_000) {
    optionsCache = inspectOptions();
    optionsCacheAt = Date.now();
  }
  return optionsCache;
}

function validSettings(input, current = {}) {
  const { agentKinds, models } = getOptions();
  const modelIds = models.map((model) => model.slug);
  const agentKind = input.agentKind ?? current.agentKind ?? agentKinds[0];
  const model = input.model ?? current.model ?? 'default';
  const effort = input.effort ?? current.effort ?? 'default';
  if (!agentKinds.includes(agentKind)) return 'Unsupported agent kind.';
  if (input.runInWorktree === true && !nativeWorktreeAgents.has(agentKind)) return 'The selected agent does not support native worktrees.';
  if (input.runInWorktree === undefined && current.runInWorktree === true && !nativeWorktreeAgents.has(agentKind)) return 'The selected agent does not support native worktrees.';
  if (model !== 'default' && !modelIds.includes(model)) return 'Unsupported model.';
  const selectedModel = models.find((item) => item.slug === model);
  if (effort !== 'default' && (!selectedModel || !selectedModel.efforts.includes(effort))) return 'Unsupported effort for the selected model.';
  return null;
}

function herdrCommand(args) {
  const result = herdrRaw(args);
  try { return JSON.parse(result); }
  catch { throw new Error(`Herdr returned an unreadable response: ${result}`); }
}

function herdrRaw(args) {
  const executable = process.env.HERDR_BIN_PATH || 'herdr';
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1_000_000 });
  if (result.error) throw new Error(`Could not run Herdr: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || `Herdr exited with status ${result.status}`).trim());
  return result.stdout;
}

function workspaceInfo(id) {
  const response = herdrCommand(['workspace', 'get', id]);
  const workspace = response?.result?.workspace || response?.workspace || response?.result || response;
  let workspaceId = workspace?.workspace_id ?? workspace?.workspaceId ?? workspace?.id ?? id;
  let cwd = workspace?.cwd ?? workspace?.path ?? workspace?.root_path ?? workspace?.rootPath ?? workspace?.working_directory ?? workspace?.workingDirectory ?? workspace?.identity_cwd ?? workspace?.resolved_identity_cwd ?? workspace?.worktree_space?.checkout_path;
  const findMetadata = (value) => {
    if (!value || typeof value !== 'object') return;
    if (!cwd && typeof value.cwd === 'string') cwd = value.cwd;
    if (!cwd && typeof value.root_path === 'string') cwd = value.root_path;
    if (!cwd && typeof value.rootPath === 'string') cwd = value.rootPath;
    if (!cwd && typeof value.working_directory === 'string') cwd = value.working_directory;
    if (!cwd && typeof value.identity_cwd === 'string') cwd = value.identity_cwd;
    if (!cwd && typeof value.resolved_identity_cwd === 'string') cwd = value.resolved_identity_cwd;
    if (!cwd && typeof value.checkout_path === 'string') cwd = value.checkout_path;
    if (!workspaceId && typeof value.workspace_id === 'string') workspaceId = value.workspace_id;
    for (const child of Object.values(value)) findMetadata(child);
  };
  findMetadata(response);
  if (cwd) {
    const root = gitResult(['rev-parse', '--show-toplevel'], cwd);
    cwd = root.status === 0 ? root.output : undefined;
  }
  if (!cwd) {
    const panes = herdrCommand(['pane', 'list', '--workspace', id]);
    const candidates = [];
    const collectPanes = (value) => {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value) && (value.pane_id || value.paneId)) candidates.push(value);
      for (const child of Object.values(value)) collectPanes(child);
    };
    collectPanes(panes);
    for (const pane of candidates) {
      if (String(pane.pane_id ?? pane.paneId) === String(process.env.HERDR_PANE_ID)) continue;
      const paneCwd = pane.foreground_cwd ?? pane.foregroundCwd ?? pane.cwd;
      if (typeof paneCwd !== 'string') continue;
      const root = gitResult(['rev-parse', '--show-toplevel'], paneCwd);
      if (root.status === 0) { cwd = root.output; break; }
    }
  }
  return { id: String(workspaceId), cwd: typeof cwd === 'string' ? cwd : undefined };
}

function gitResult(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.error) throw new Error(result.error.message);
  return { status: result.status, output };
}

function listGitWorktrees(cwd) {
  const result = gitResult(['worktree', 'list', '--porcelain'], cwd);
  if (result.status !== 0) throw new Error(result.output || 'Could not inspect Git worktrees.');
  return result.output.split(/\n\s*\n/).map((block) => ({
    cwd: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
  })).filter((item) => item.cwd);
}

async function taskPrompt(task, body) {
  const guidance = await readFile(path.join(root, 'HERDR.md'), 'utf8');
  return [body, task.attachments?.length ? `Attached files:\n${task.attachments.map((file) => `- ${file.name}: ${file.path}`).join('\n')}` : '', guidance].filter(Boolean).join('\n\n');
}

let worktreeLaunchQueue = Promise.resolve();
function launchCodex(task) {
  if (!task.runInWorktree) return launchCodexNow(task);
  const launch = worktreeLaunchQueue.then(() => launchCodexNow(task));
  worktreeLaunchQueue = launch.catch(() => {});
  return launch;
}

async function launchCodexNow(task) {
  const baseWorkspace = process.env.HERDR_WORKSPACE_ID;
  if (!baseWorkspace) throw new Error('This action needs an active Herdr workspace to open a new tab.');
  if (task.runInWorktree && !nativeWorktreeAgents.has(task.agentKind)) throw new Error('The selected agent does not support native worktrees.');
  const baseInfo = workspaceInfo(baseWorkspace);
  if (task.runInWorktree && !baseInfo.cwd) throw new Error('Herdr did not provide the active workspace repository path.');
  if (task.runInWorktree) {
    const head = gitResult(['rev-parse', '--verify', 'HEAD'], baseInfo.cwd);
    if (head.status !== 0) throw new Error('Codex native worktrees require the active repository to have at least one commit. Create an initial commit or disable “Run task in worktree” for this task.');
  }
  const beforeWorktrees = task.runInWorktree ? new Set(listGitWorktrees(baseInfo.cwd).map((item) => item.cwd)) : null;
  const label = task.title.slice(0, 40);
  const created = herdrCommand(['tab', 'create', '--workspace', baseWorkspace, '--label', label, '--focus']);
  const pane = created?.result?.root_pane?.pane_id;
  const tab = created?.result?.tab?.tab_id;
  if (!pane || !tab) throw new Error('Herdr created a tab but did not return its tab and pane IDs.');
  const agent = `task-${task.id.replace(/-/g, '').slice(0, 8)}`;
  const { agentKinds, models } = getOptions();
  if (!agentKinds.includes(task.agentKind)) throw new Error('The task agent is not supported by the current Herdr setup.');
  const kind = task.agentKind;
  const agentArgs = kind === 'codex' ? [
    ...(task.runInWorktree ? ['--enable', 'worktrees', '--worktree'] : []),
    ...(models.some((model) => model.slug === task.model) ? ['--model', task.model] : []),
    ...(task.effort !== 'default' ? ['-c', `model_reasoning_effort=${task.effort}`] : []),
  ] : [];
  herdrCommand(['agent', 'start', agent, '--kind', kind, '--pane', pane, '--timeout', '120000', ...(agentArgs.length ? ['--', ...agentArgs] : [])]);
  let nativeWorktree;
  if (task.runInWorktree) {
    nativeWorktree = listGitWorktrees(baseInfo.cwd).find((item) => !beforeWorktrees.has(item.cwd));
    if (!nativeWorktree?.branch) throw new Error('Codex started, but its native worktree could not be identified in Git.');
  }
  watchAgentCompletion(task.id, agent);
  const description = [task.title, task.description].filter(Boolean).join('\n\n');
  const prompt = await taskPrompt(task, description);
  herdrCommand(['agent', 'prompt', agent, prompt]);
  return { tab, pane, agent, workspace: baseWorkspace, ...(nativeWorktree ? { worktree: { branch: nativeWorktree.branch, cwd: nativeWorktree.cwd, baseCwd: baseInfo.cwd } } : {}) };
}

function mergeReadiness(task) {
  if (!task.runInWorktree || !task.launch?.worktree) return undefined;
  if (task.mergedAt) return { status: 'merged', message: 'Merged into main' };
  const { cwd, baseCwd, branch } = task.launch.worktree;
  if (!cwd || !baseCwd) return { status: 'problem', message: 'Herdr did not provide the repository path for this worktree.' };
  try {
    const dirty = gitResult(['status', '--porcelain', '--untracked-files=all'], cwd);
    if (dirty.status !== 0) return { status: 'problem', message: dirty.output || 'Could not inspect the task worktree.' };
    if (dirty.output) return { status: 'problem', message: dirty.output };
    const commits = gitResult(['rev-list', '--count', `main..${branch}`], baseCwd);
    if (commits.status !== 0) return { status: 'problem', message: commits.output || 'Could not inspect task commits.' };
    if (Number(commits.output) < 1) return { status: 'problem', message: 'No task commits to merge yet.' };
    const check = gitResult(['merge-tree', '--write-tree', 'main', branch], baseCwd);
    return check.status === 0 ? { status: 'safe', message: 'Safe to merge' } : { status: 'problem', message: check.output || 'Git could not merge this branch cleanly.' };
  } catch (error) { return { status: 'problem', message: error.message }; }
}

function mergeTaskToMain(task) {
  if (task.mergedAt) return;
  const info = task.launch?.worktree;
  if (!info?.branch || !info.baseCwd) throw new Error('Task worktree information is unavailable.');
  const readiness = mergeReadiness(task);
  if (readiness?.status !== 'safe') throw new Error(readiness?.message || 'The task is not safe to merge yet.');
  const worktrees = gitResult(['worktree', 'list', '--porcelain'], info.baseCwd);
  if (worktrees.status !== 0) throw new Error(worktrees.output || 'Could not locate the main worktree.');
  let mainCwd;
  for (const block of worktrees.output.split(/\n\n/)) {
    const worktreePath = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/main$/m);
    if (worktreePath && branch) { mainCwd = worktreePath; break; }
  }
  if (!mainCwd) {
    const mainHead = gitResult(['rev-parse', 'refs/heads/main'], info.baseCwd);
    if (mainHead.status !== 0) throw new Error(mainHead.output || 'Could not resolve main.');
    const taskHead = gitResult(['rev-parse', `refs/heads/${info.branch}`], info.baseCwd);
    if (taskHead.status !== 0) throw new Error(taskHead.output || 'Could not resolve the task branch.');
    const tree = gitResult(['merge-tree', '--write-tree', 'main', info.branch], info.baseCwd);
    if (tree.status !== 0) throw new Error(tree.output || 'Git could not merge this branch cleanly.');
    const mergeCommit = gitResult(['commit-tree', tree.output.split('\n')[0], '-p', mainHead.output, '-p', taskHead.output, '-m', `Merge task ${task.id} into main`], info.baseCwd);
    if (mergeCommit.status !== 0) throw new Error(mergeCommit.output || 'Could not create the merge commit.');
    const update = gitResult(['update-ref', 'refs/heads/main', mergeCommit.output, mainHead.output], info.baseCwd);
    if (update.status !== 0) throw new Error(update.output || 'main changed during merge; try again.');
    return;
  }
  const result = gitResult(['merge', '--no-ff', '--no-edit', info.branch], mainCwd);
  if (result.status === 0) return;
  const output = result.output || 'Git merge failed.';
  const aborted = gitResult(['merge', '--abort'], mainCwd);
  throw new Error([output, aborted.status === 0 ? 'Merge aborted.' : `Could not abort merge: ${aborted.output}`].filter(Boolean).join('\n'));
}

function createTaskTab(task) {
  const workspace = task.launch?.workspace || process.env.HERDR_WORKSPACE_ID;
  if (!workspace) throw new Error('This action needs an active Herdr workspace to open a tab.');
  const created = herdrCommand(['tab', 'create', '--workspace', workspace, '--label', task.title.slice(0, 40), '--focus']);
  const tab = created?.result?.tab?.tab_id;
  if (!tab) throw new Error('Herdr created a tab but did not return its tab ID.');
  return tab;
}

function openTabIds(value) {
  const ids = new Set();
  const visit = (item) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== 'object') return;
    const id = item.tab_id ?? item.tabId;
    if (id) ids.add(String(id));
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return ids;
}

function watchAgentCompletion(taskId, agent) {
  const executable = process.env.HERDR_BIN_PATH || 'herdr';
  const watcher = spawn(executable, ['agent', 'wait', agent, '--until', 'done'], { stdio: 'ignore' });
  watcher.on('error', () => {});
  watcher.on('exit', async (code) => {
    if (code !== 0) return;
    try {
      const tasks = await loadTasks();
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return;
      if (task.status !== 'done') task.status = 'review';
      task.agentState = 'done'; task.sawWorking = true;
      await saveTasks(tasks);
    } catch {}
  });
}

async function loadTasks() {
  try { return JSON.parse(await readFile(dataFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function saveTasks(tasks) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dataFile, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
}

async function storeAttachments(taskId, input, existingBytes = 0) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw Object.assign(new Error('Attachments must be a list of files.'), { statusCode: 400 });
  let totalBytes = existingBytes;
  const files = input.map((file) => {
    if (!file || typeof file.name !== 'string' || typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
      throw Object.assign(new Error('An attachment could not be read.'), { statusCode: 400 });
    }
    const size = Buffer.from(file.data, 'base64').length;
    totalBytes += size;
    if (totalBytes > maxAttachmentBytes) throw Object.assign(new Error('Attachments must total 30 MiB or less.'), { statusCode: 413 });
    const basename = path.basename(file.name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '_').trim() || 'attachment';
    return { name: basename, size, data: file.data };
  });
  if (!files.length) return [];
  const attachmentDir = path.join(dataDir, 'attachments', taskId);
  await mkdir(attachmentDir, { recursive: true });
  const saved = [];
  for (const [index, file] of files.entries()) {
    const filename = `${String(index + 1).padStart(2, '0')}-${file.name}`;
    const filePath = path.resolve(attachmentDir, filename);
    await writeFile(filePath, Buffer.from(file.data, 'base64'), { flag: 'wx' });
    saved.push({ name: file.name, path: filePath, size: file.size });
  }
  return saved;
}

async function reconcileTasks(tasks) {
  let changed = false;
  let agents = [];
  try {
    const result = herdrCommand(['agent', 'list']);
    agents = result?.result?.agents || result?.agents || [];
  } catch { return tasks; }
  for (const task of tasks) {
    if (!task.launch?.pane) continue;
    const agent = agents.find((item) => item.pane_id === task.launch.pane);
    const state = agent?.agent_status;
    if (!agent) {
      if (task.agentState !== 'gone') { task.agentState = 'gone'; changed = true; }
      continue;
    }
    if (state === 'working') {
      if (task.status !== 'in-progress') { task.status = 'in-progress'; changed = true; }
      if (!task.sawWorking) { task.sawWorking = true; changed = true; }
    }
    if (state === 'done' && task.status !== 'done') {
      task.status = 'review'; task.sawWorking = true; changed = true;
    }
    if (task.agentState !== state && state) { task.agentState = state; changed = true; }
  }
  if (changed) await saveTasks(tasks);
  return tasks;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function bodyOf(req, limit = 32_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
  }
  return JSON.parse(raw || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/options' && req.method === 'GET') return send(res, 200, getOptions());
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const tasks = await loadTasks();
      const reconciled = await reconcileTasks(tasks);
      let openTabs = null;
      try { openTabs = openTabIds(herdrCommand(['tab', 'list', ...(process.env.HERDR_WORKSPACE_ID ? ['--workspace', process.env.HERDR_WORKSPACE_ID] : [])])); } catch {}
      return send(res, 200, reconciled.map((task) => ({ ...task, mergeReadiness: task.runInWorktree ? (mergeReadiness(task) || (task.launchError ? { status: 'problem', message: task.launchError } : { status: 'pending', message: 'Worktree has not started yet.' })) : undefined, herdrTabOpen: Boolean(task.launch?.tab && openTabs?.has(String(task.launch.tab))) })));
    }
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const input = await bodyOf(req, maxTaskRequestBytes);
      const title = String(input.title || '').trim();
      if (!title) return send(res, 400, { error: 'A title is required.' });
      const settingsError = validSettings(input);
      if (settingsError) return send(res, 400, { error: settingsError });
      const status = columns.includes(input.status) ? input.status : 'backlog';
      const id = randomUUID();
      const attachments = await storeAttachments(id, input.attachments);
      const agentKind = input.agentKind || 'codex';
      const runInWorktree = input.runInWorktree === undefined ? nativeWorktreeAgents.has(agentKind) : input.runInWorktree === true;
      const task = { id, title: title.slice(0, 120), description: String(input.description || '').slice(0, 1000), attachments, priority: ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium', agentKind, model: input.model || 'default', effort: input.effort || 'default', runInWorktree, status, createdAt: new Date().toISOString() };
      const tasks = await loadTasks(); tasks.unshift(task); await saveTasks(tasks);
      if (status === 'todo') {
        try { task.launch = await launchCodex(task); task.status = 'in-progress'; task.agentState = 'starting'; }
        catch (error) { task.launchError = error.message; }
        await saveTasks(tasks);
      }
      return send(res, 201, task);
    }
    const match = url.pathname.match(/^\/api\/tasks\/([\w-]+)$/);
    if (match && req.method === 'PATCH') {
      const input = await bodyOf(req, maxTaskRequestBytes); const tasks = await loadTasks();
      const task = tasks.find((item) => item.id === match[1]);
      if (!task) return send(res, 404, { error: 'Task not found.' });
      if ('agentKind' in input && !task.launch && !nativeWorktreeAgents.has(input.agentKind)) input.runInWorktree = false;
      const settingsError = validSettings(input, task);
      if (settingsError && ['agentKind', 'model', 'effort'].some((key) => key in input)) return send(res, 400, { error: settingsError });
      const settingsRequested = ['agentKind', 'model', 'effort'].some((key) => key in input);
      if (settingsRequested && task.agentState === 'working') return send(res, 409, { error: 'Agent settings cannot be changed while the agent is running.' });
      let addedAttachments = [];
      if ('attachments' in input) {
        const existingBytes = (task.attachments || []).reduce((total, file) => total + (Number(file.size) || 0), 0);
        addedAttachments = await storeAttachments(task.id, input.attachments, existingBytes);
        task.attachments = [...(task.attachments || []), ...addedAttachments];
      }
      const wasStatus = task.status;
      const requestedStatus = 'status' in input && columns.includes(input.status) ? input.status : task.status;
      const startingTask = wasStatus !== 'todo' && requestedStatus === 'todo';
      if ('title' in input && String(input.title).trim()) task.title = String(input.title).trim().slice(0, 120);
      if ('description' in input) task.description = String(input.description).slice(0, 1000);
      if ('priority' in input && ['low', 'medium', 'high'].includes(input.priority)) task.priority = input.priority;
      if ('agentKind' in input) task.agentKind = input.agentKind;
      if ('model' in input) task.model = input.model;
      if ('effort' in input) task.effort = input.effort;
      if ('runInWorktree' in input && typeof input.runInWorktree === 'boolean' && !task.launch) task.runInWorktree = input.runInWorktree;
      if (wasStatus !== 'todo' && requestedStatus === 'todo') {
        task.status = 'todo';
        try { task.launch = await launchCodex(task); task.status = 'in-progress'; task.agentState = 'starting'; delete task.launchError; }
        catch (error) { task.launchError = error.message; }
      }
      if (requestedStatus === 'done' && wasStatus !== 'done') {
        if (task.runInWorktree) {
          try { mergeTaskToMain(task); task.status = 'done'; task.mergedAt = new Date().toISOString(); delete task.mergeProblem; }
          catch (error) { task.status = 'review'; task.mergeProblem = error.message; }
        } else task.status = 'done';
      } else if (requestedStatus !== 'todo' || wasStatus === 'todo') task.status = requestedStatus;
      if (task.status === 'done' && wasStatus !== 'done' && task.launch?.tab) {
        try { herdrCommand(['tab', 'close', task.launch.tab]); } catch {}
        delete task.launch.tab;
      }
      await saveTasks(tasks);
      let attachmentPromptError;
      if (addedAttachments.length && !startingTask && task.status === 'in-progress' && task.launch?.agent) {
        const body = `Description update — attached files:\n${addedAttachments.map((file) => `- ${file.name}: ${file.path}`).join('\n')}`;
        try { herdrCommand(['agent', 'prompt', task.launch.agent, await taskPrompt(task, body)]); }
        catch (error) { attachmentPromptError = error.message; }
      }
      return send(res, 200, { ...task, ...(attachmentPromptError ? { attachmentPromptError } : {}) });
    }
    const detailMatch = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/(output|focus)$/);
    if (detailMatch) {
      const task = (await loadTasks()).find((item) => item.id === detailMatch[1]);
      if (!task) return send(res, 404, { error: 'Task not found.' });
      if (detailMatch[2] === 'focus' && req.method === 'POST') {
        if (task.launch?.tab) {
          try { herdrCommand(['tab', 'focus', task.launch.tab]); }
          catch {
            const tab = createTaskTab(task);
            task.launch.tab = tab;
            await saveTasks(await loadTasks().then((tasks) => tasks.map((item) => item.id === task.id ? task : item)));
          }
        } else {
          task.launch = { ...(task.launch || {}), tab: createTaskTab(task) };
          const tasks = await loadTasks();
          await saveTasks(tasks.map((item) => item.id === task.id ? task : item));
        }
        return send(res, 200, { ok: true });
      }
      if (detailMatch[2] === 'output' && req.method === 'GET') {
        if (!task.launch?.pane) return send(res, 200, { text: 'No Herdr tab has been started for this task yet.' });
        const text = herdrRaw(['pane', 'read', task.launch.pane, '--source', 'recent-unwrapped', '--lines', '100']);
        return send(res, 200, { text });
      }
    }
    const tabCloseMatch = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/tab$/);
    if (tabCloseMatch && req.method === 'DELETE') {
      const tasks = await loadTasks();
      const task = tasks.find((item) => item.id === tabCloseMatch[1]);
      if (!task) return send(res, 404, { error: 'Task not found.' });
      if (task.launch?.tab) {
        try { herdrCommand(['tab', 'close', task.launch.tab]); } catch {}
        delete task.launch.tab;
        await saveTasks(tasks);
      }
      return send(res, 200, { ok: true });
    }
    if (match && req.method === 'DELETE') {
      const tasks = await loadTasks(); const next = tasks.filter((item) => item.id !== match[1]);
      if (next.length === tasks.length) return send(res, 404, { error: 'Task not found.' });
      await saveTasks(next); return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, await readFile(path.join(root, 'public/index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    const vendorFiles = {
      '/vendor/xterm.mjs': ['node_modules/@xterm/xterm/lib/xterm.mjs', 'text/javascript; charset=utf-8'],
      '/vendor/addon-fit.mjs': ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript; charset=utf-8'],
      '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
    };
    if (req.method === 'GET' && vendorFiles[url.pathname]) {
      const [file, type] = vendorFiles[url.pathname];
      return send(res, 200, await readFile(path.join(root, file), 'utf8'), type);
    }
    if (req.method === 'GET' && ['/app.css', '/details.css', '/app.js'].includes(url.pathname)) {
      const file = url.pathname.slice(1);
      return send(res, 200, await readFile(path.join(root, 'public', file), 'utf8'), file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    return send(res, error.statusCode || 500, { error: error.message || 'Unexpected error.' });
  }
});

const terminalSockets = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/terminal$/);
  let originAllowed = true;
  if (req.headers.origin) {
    try { originAllowed = new URL(req.headers.origin).host === req.headers.host; }
    catch { originAllowed = false; }
  }
  if (!match || !originAllowed) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  try {
    const task = (await loadTasks()).find((item) => item.id === match[1]);
    if (!task) throw new Error('Task not found.');
    terminalSockets.handleUpgrade(req, socket, head, (client) => {
      terminalSockets.emit('connection', client, req, task.launch?.pane || null);
    });
  } catch (error) {
    const status = error.message === 'Task not found.' ? '404 Not Found' : '409 Conflict';
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
});

terminalSockets.on('connection', (client, _req, pane) => {
  if (!pane) {
    const message = 'This task has no Herdr pane yet. Move it to To do to start its agent.';
    client.send(JSON.stringify({ type: 'error', message }));
    client.close(1008, message);
    return;
  }
  let pollActive = false;
  let lastSnapshot = null;
  let inputBuffer = '';
  let inputTimer;
  const sendMessage = (message) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const poll = async () => {
    if (pollActive || client.readyState !== WebSocket.OPEN) return;
    pollActive = true;
    try {
      const text = await herdrRawAsync(['pane', 'read', pane, '--source', 'recent', '--lines', '100', '--format', 'ansi']);
      if (text !== lastSnapshot) {
        lastSnapshot = text;
        sendMessage({ type: 'snapshot', text });
      }
    } catch (error) {
      sendMessage({ type: 'error', message: `Could not read the Herdr pane: ${error.message}` });
    } finally { pollActive = false; }
  };
  const flushInput = async () => {
    inputTimer = null;
    const data = inputBuffer;
    inputBuffer = '';
    if (client.readyState !== WebSocket.OPEN || !data) return;
    try {
      for (const item of paneInputCommands(data)) await herdrRawAsync(['pane', item.command, pane, ...(item.key ? [item.key] : [item.text])]);
    } catch (error) {
      sendMessage({ type: 'error', message: `Could not send input to the Herdr pane: ${error.message}` });
    }
  };
  client.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message?.type !== 'input' || typeof message.data !== 'string' || message.data.length > 4096) return;
    inputBuffer += message.data;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(flushInput, 25);
  });
  client.on('close', () => clearTimeout(inputTimer));
  poll();
  const pollTimer = setInterval(poll, 850);
  client.on('close', () => clearInterval(pollTimer));
});

function paneInputCommands(data) {
  const commands = [];
  const keys = new Map([
    ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'],
    ['\x1b[H', 'home'], ['\x1b[F', 'end'], ['\x1b[3~', 'delete'], ['\x1b[Z', 'shift+tab'],
    ['\r', 'enter'], ['\n', 'enter'], ['\t', 'tab'], ['\x7f', 'backspace'], ['\x1b', 'esc'],
  ]);
  let text = '';
  const flushText = () => { if (text) { commands.push({ command: 'send-text', text }); text = ''; } };
  for (let i = 0; i < data.length;) {
    let match;
    for (const [sequence, key] of keys) {
      if (data.startsWith(sequence, i)) { match = { sequence, key }; break; }
    }
    if (match) {
      flushText(); commands.push({ command: 'send-keys', key: match.key }); i += match.sequence.length; continue;
    }
    const code = data.charCodeAt(i);
    if (code >= 1 && code <= 26) {
      flushText(); commands.push({ command: 'send-keys', key: `ctrl+${String.fromCharCode(code + 96)}` }); i++; continue;
    }
    text += data[i++];
  }
  flushText();
  return commands;
}

function herdrRawAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.HERDR_BIN_PATH || 'herdr', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => child.kill(), 10_000);
    const fail = (error) => { if (settled) return; settled = true; clearTimeout(timeout); reject(error); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 1_000_000) child.kill(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 64_000) child.kill(); });
    child.on('error', (error) => fail(new Error(`Could not run Herdr: ${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (code !== 0) reject(new Error((stderr || `Herdr exited with status ${code}`).trim()));
      else resolve(stdout);
    });
  });
}

server.listen(Number(process.env.PORT) || 4173, '127.0.0.1', () => {
  const address = server.address();
  console.log(`Herdr Kanban is ready at http://127.0.0.1:${address.port}`);
  console.log(`Tasks are saved in ${dataDir}`);
});
