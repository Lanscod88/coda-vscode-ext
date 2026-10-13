const vscode = acquireVsCodeApi();

const chatView = document.getElementById('chatView');
const customizeView = document.getElementById('customizeView');
const settingsView = document.getElementById('settingsView');

const openCustomizeBtn = document.getElementById('openCustomizeBtn');
const closeCustomizeBtn = document.getElementById('closeCustomizeBtn');
const openSettingsBtn = document.getElementById('openSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');

const protocolSelect = document.getElementById('protocolSelect');
const baseUrlInput = document.getElementById('baseUrlInput');
const apiKeyInput = document.getElementById('apiKeyInput');
const numCtxSelect = document.getElementById('numCtxSelect');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');

const modelSelect = document.getElementById('modelSelect');
const refreshBtn = document.getElementById('refreshBtn');
const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const responseArea = document.getElementById('responseArea');
const loadingIndicator = document.getElementById('loadingIndicator');
const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');

const collabCheckbox = document.getElementById('collabCheckbox');
const collabSubPanel = document.getElementById('collabSubPanel');
const designModelSelect = document.getElementById('designModelSelect');
const implModelSelect = document.getElementById('implModelSelect');
const activeSkillSelect = document.getElementById('activeSkillSelect');

const saveSkillBtn = document.getElementById('saveSkillBtn');
const newSkillName = document.getElementById('newSkillName');
const newSkillContent = document.getElementById('newSkillContent');
const skillsListContainer = document.getElementById('skillsListContainer');

function switchView(viewName) {
  chatView.classList.remove('active');
  customizeView.classList.remove('active');
  settingsView.classList.remove('active');

  if (viewName === 'chat') {
    chatView.classList.add('active');
    vscode.postMessage({type: 'getModels'});
  } else if (viewName === 'customize') {
    customizeView.classList.add('active');
    vscode.postMessage({type: 'getSkills'});
  } else if (viewName === 'settings') {
    settingsView.classList.add('active');
    vscode.postMessage({type: 'getSettings'});
  }
}

openCustomizeBtn.addEventListener('click', () => switchView('customize'));
closeCustomizeBtn.addEventListener('click', () => switchView('chat'));
openSettingsBtn.addEventListener('click', () => switchView('settings'));
closeSettingsBtn.addEventListener('click', () => switchView('chat'));

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

collabCheckbox.addEventListener('change', () => {
  const active = collabCheckbox.checked;
  if (active) {
    collabSubPanel.classList.add('active');
    designModelSelect.disabled = false;
    implModelSelect.disabled = false;
    sendBtn.textContent = '🚀 开始协同开发';
  } else {
    collabSubPanel.classList.remove('active');
    designModelSelect.disabled = true;
    implModelSelect.disabled = true;
    sendBtn.textContent = '发送';
  }
});

window.addEventListener('load', () => {
  vscode.postMessage({type: 'getSettings'});
  vscode.postMessage({type: 'getModels'});
  vscode.postMessage({type: 'getHistory'});
  vscode.postMessage({type: 'getSkills'});
});

refreshBtn.addEventListener('click', () => {
  modelSelect.innerHTML = '<option>正在获取模型列表...</option>';
  vscode.postMessage({type: 'getModels'});
});

saveSettingsBtn.addEventListener('click', () => {
  const settings = {
    protocol: protocolSelect.value,
    baseUrl: baseUrlInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    numCtx: numCtxSelect.value,
  };
  vscode.postMessage({type: 'saveSettings', settings});
});

saveSkillBtn.addEventListener('click', () => {
  const name = newSkillName.value.trim();
  const content = newSkillContent.value.trim();
  if (!name || !content) return;
  vscode.postMessage({type: 'saveSkill', skill: {name, content}});
  newSkillName.value = '';
  newSkillContent.value = '';
});

sendBtn.addEventListener('click', sendMessage);
promptInput.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') {
    if (!sendBtn.disabled) sendMessage();
  }
});

selectAllCheckbox.addEventListener('change', () => {
  const checkboxes = document.querySelectorAll('.history-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = selectAllCheckbox.checked;
  });
});

deleteSelectedBtn.addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('.history-checkbox:checked');
  const ids = Array.from(checkboxes).map(cb => parseInt(cb.dataset.id));
  if (ids.length === 0) return;
  vscode.postMessage({type: 'deleteHistory', ids});
});

function sendMessage() {
  const prompt = promptInput.value.trim();
  const model = modelSelect.value;
  const collabEnabled = collabCheckbox.checked;
  const collabConfig = {
    designModel: designModelSelect.value,
    implModel: implModelSelect.value,
  };
  const activeSkill = activeSkillSelect.value;

  if (!prompt || !model) return;

  sendBtn.disabled = true;
  promptInput.value = '';
  loadingIndicator.style.display = 'flex';

  vscode.postMessage({
    type: 'sendMessage',
    prompt,
    model,
    collabEnabled,
    collabConfig,
    activeSkill,
  });
}

window.addEventListener('message', event => {
  const message = event.data;
  switch (message.type) {
    case 'toggleSettingsView':
      switchView('settings');
      break;
    case 'loadSettings':
      const s = message.settings;
      protocolSelect.value = s.protocol || 'ollama';
      baseUrlInput.value = s.baseUrl || 'http://127.0.0.1:11434';
      apiKeyInput.value = s.apiKey || '';
      numCtxSelect.value = s.numCtx || '32k';
      break;
    case 'settingsSaved':
      switchView('chat');
      break;
    case 'modelList':
      populateModels(message.models, message.selectedModel);
      break;
    case 'renderSkills':
      renderSkillsList(message.skills);
      break;
    case 'renderHistory':
      renderHistoryList(message.history);
      break;
    case 'streamChunk':
      loadingIndicator.style.display = 'none';
      const curr = document.querySelector('.active-streaming');
      if (curr) {
        curr.textContent += message.chunk;
        let html = curr.textContent;
        html = html.split('<think>').join('<div class="thinking">思考中...<br>');
        html = html.split('</think>').join('</div><hr>');
        curr.innerHTML = html;
        const container = document.getElementById('chat-container');
        container.scrollTop = container.scrollHeight;
      }
      break;
    case 'showReviewAction':
      loadingIndicator.style.display = 'none';
      const lastContentDiv = document.querySelector('.active-streaming');
      if (lastContentDiv) {
        showReviewButtons(message.historyId, message.reviewText, message.implModel, lastContentDiv);
      }
      break;
    case 'streamEnd':
      loadingIndicator.style.display = 'none';
      sendBtn.disabled = false;
      const activeBox = document.querySelector('.response-box:not(.completed)');
      if (activeBox) activeBox.classList.add('completed');
      const activeContent = document.querySelector('.active-streaming');
      if (activeContent) {
        const badge = document.createElement('div');
        badge.className = 'task-done-badge';
        badge.textContent = '✅ 任务完成';
        activeContent.appendChild(badge);
        activeContent.classList.remove('active-streaming');
      }
      break;
  }
});

function populateModels(models, selectedModel) {
  const selects = [modelSelect, designModelSelect, implModelSelect];
  selects.forEach(select => {
    select.innerHTML = '';
    if (!models || models.length === 0) {
      select.innerHTML = '<option>未检测到可用模型</option>';
      return;
    }
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (select === modelSelect && selectedModel && m === selectedModel) opt.selected = true;
      if (select === designModelSelect && m.toLowerCase().includes('deepseek')) opt.selected = true;
      if (
        select === implModelSelect &&
        (m.toLowerCase().includes('coder') || m.toLowerCase().includes('qwen'))
      )
        opt.selected = true;
      select.appendChild(opt);
    });
    if (select.selectedIndex === -1 && models.length > 0) select.selectedIndex = 0;
  });
}

function showReviewButtons(historyId, reviewText, implModel, targetDiv) {
  if (!targetDiv) return;
  if (targetDiv.querySelector('.action-buttons')) return;

  const actionDiv = document.createElement('div');
  actionDiv.className = 'action-buttons';
  actionDiv.innerHTML = `
    <button class="btn-accept" id="acceptReviewBtn-${historyId}">✅ 同意建议并修改代码</button>
    <button class="btn-skip" id="skipReviewBtn-${historyId}">❌ 忽略并结束</button>
  `;
  targetDiv.appendChild(actionDiv);

  document.getElementById(`acceptReviewBtn-${historyId}`).addEventListener('click', () => {
    actionDiv.remove();
    loadingIndicator.style.display = 'flex';
    sendBtn.disabled = true;
    vscode.postMessage({type: 'approveReview', historyId, reviewText, implModel});
  });

  document.getElementById(`skipReviewBtn-${historyId}`).addEventListener('click', () => {
    actionDiv.remove();
    const badge = document.createElement('div');
    badge.className = 'task-done-badge';
    badge.textContent = '✅ 审查完成 (已忽略修改)';
    targetDiv.appendChild(badge);
    sendBtn.disabled = false;
  });

  const container = document.getElementById('chat-container');
  container.scrollTop = container.scrollHeight;
}

function renderSkillsList(skills) {
  skillsListContainer.innerHTML = '';
  activeSkillSelect.innerHTML = '<option value="">-- 不使用 Skill --</option>';

  if (!skills || skills.length === 0) {
    skillsListContainer.innerHTML =
      '<div style="font-size: 11px; color: var(--vscode-descriptionForeground);">暂无自定义 Skill</div>';
    return;
  }

  skills.forEach(skill => {
    const opt = document.createElement('option');
    opt.value = skill.content;
    opt.textContent = skill.name;
    activeSkillSelect.appendChild(opt);

    const item = document.createElement('div');
    item.className = 'skill-item';
    item.innerHTML = `<span>⚡ ${skill.name}</span><button class="btn-refresh" style="padding: 2px 4px; font-size: 10px;" data-name="${skill.name}">删除</button>`;
    item.querySelector('button').addEventListener('click', () => {
      vscode.postMessage({type: 'deleteSkill', name: skill.name});
    });
    skillsListContainer.appendChild(item);
  });
}

function renderHistoryList(history) {
  responseArea.innerHTML = '';
  if (selectAllCheckbox) selectAllCheckbox.checked = false;

  history.forEach(item => {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-item-wrapper';

    const headerRow = document.createElement('div');
    headerRow.className = 'chat-header-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'history-checkbox';
    checkbox.dataset.id = item.id;
    checkbox.addEventListener('change', () => {
      const all = document.querySelectorAll('.history-checkbox');
      const checked = document.querySelectorAll('.history-checkbox:checked');
      selectAllCheckbox.checked = all.length > 0 && all.length === checked.length;
    });

    const userMsg = document.createElement('div');
    userMsg.className = 'user-msg';
    userMsg.textContent = '用户: ' + item.prompt;

    headerRow.appendChild(checkbox);
    headerRow.appendChild(userMsg);
    wrapper.appendChild(headerRow);

    const details = document.createElement('details');
    details.className = 'response-box' + (item.completed ? ' completed' : '');
    if (!item.completed || item.reviewPending) details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'response-summary';
    summary.textContent = '模型回复 (' + item.model + ')';
    details.appendChild(summary);

    const contentDiv = document.createElement('div');
    contentDiv.className =
      'response-content' + (!item.completed && !item.reviewPending ? ' active-streaming' : '');

    let html = item.response || '';
    html = html.split('<think>').join('<div class="thinking">思考中...<br>');
    html = html.split('</think>').join('</div><hr>');
    contentDiv.innerHTML = html;

    if (item.completed) {
      const badge = document.createElement('div');
      badge.className = 'task-done-badge';
      badge.textContent = '✅ 任务完成';
      contentDiv.appendChild(badge);
    } else if (item.reviewPending) {
      setTimeout(() => {
        showReviewButtons(item.id, item.reviewText, item.model, contentDiv);
      }, 50);
    } else {
      contentDiv.classList.add('active-streaming');
    }

    details.appendChild(contentDiv);
    wrapper.appendChild(details);
    responseArea.appendChild(wrapper);
  });

  const container = document.getElementById('chat-container');
  container.scrollTop = container.scrollHeight;
}
