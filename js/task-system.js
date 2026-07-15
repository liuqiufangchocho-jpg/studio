(function (global) {
  'use strict';

  const config = global.SUPABASE_CONFIG || {};
  const VALID_TASK_STATUSES = new Set(['active', 'closed']);

  function ensureReady() {
    return Boolean(config.url && config.anonKey);
  }

  function assertReady() {
    if (!ensureReady()) {
      throw new Error('Supabase URL 或 anon public key 缺失。');
    }
  }

  function headers(extra = {}) {
    assertReady();
    return {
      apikey: config.anonKey,
      Authorization: `Bearer ${config.anonKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra
    };
  }

  function restUrl(table, query = '') {
    assertReady();
    return `${config.url}/rest/v1/${table}${query ? `?${query}` : ''}`;
  }

  function eqFilter(field, value) {
    return `${encodeURIComponent(field)}=eq.${encodeURIComponent(String(value))}`;
  }

  function isNullFilter(field) {
    return `${encodeURIComponent(field)}=is.null`;
  }

  async function parseResponse(response) {
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = text;
    }

    if (!response.ok) {
      const message = data && typeof data === 'object'
        ? (data.message || data.error || data.hint || JSON.stringify(data))
        : text;
      throw new Error(message || `Supabase request failed: ${response.status}`);
    }

    return data;
  }

  async function select(table, query = '') {
    const response = await fetch(restUrl(table, query), {
      method: 'GET',
      headers: headers()
    });
    const data = await parseResponse(response);
    return Array.isArray(data) ? data : [];
  }

  async function selectOne(table, filters = [], selectFields = '*') {
    const query = [`select=${encodeURIComponent(selectFields)}`, ...filters, 'limit=1'].join('&');
    const rows = await select(table, query);
    return rows.length ? rows[0] : null;
  }

  async function insert(table, payload, { returnRepresentation = false } = {}) {
    const response = await fetch(restUrl(table), {
      method: 'POST',
      headers: headers({
        Prefer: returnRepresentation ? 'return=representation' : 'return=minimal'
      }),
      body: JSON.stringify(payload)
    });
    const data = await parseResponse(response);
    if (returnRepresentation) {
      return Array.isArray(data) ? data[0] || null : data;
    }
    return null;
  }

  async function updateById(table, id, payload, { returnRepresentation = false } = {}) {
    const response = await fetch(restUrl(table, eqFilter('id', id)), {
      method: 'PATCH',
      headers: headers({
        Prefer: returnRepresentation ? 'return=representation' : 'return=minimal'
      }),
      body: JSON.stringify(payload)
    });
    const data = await parseResponse(response);
    if (returnRepresentation) {
      return Array.isArray(data) ? data[0] || null : data;
    }
    return null;
  }

  function generateTaskCode(length = 12) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let code = 't_';
    for (let i = 0; i < bytes.length; i += 1) {
      code += alphabet[bytes[i] % alphabet.length];
    }
    return code;
  }

  function parseStudentList(value) {
    const lines = String(value || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const classMap = new Map();

    lines.forEach(line => {
      const parts = line.split(/[,，\t]+/).map(part => part.trim()).filter(Boolean);
      if (parts.length < 2) return;

      const className = parts[0];
      const studentName = parts.slice(1).join(' ').trim();
      if (!className || !studentName) return;

      if (!classMap.has(className)) classMap.set(className, []);
      const students = classMap.get(className);
      if (!students.includes(studentName)) students.push(studentName);
    });

    return Array.from(classMap.entries()).map(([className, students]) => ({
      className,
      students
    }));
  }

  function extractTaskId(input) {
    if (!input) return '';

    let text = String(input).trim().replace(/\s+/g, ' ');
    if (!text) return '';

    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    let candidate = urlMatch ? urlMatch[0] : text;
    candidate = candidate.replace(/[，。,.；;！!？?）)\]]+$/g, '').trim();

    const directParamMatch = candidate.match(/[?&](taskId|taskid|task|task_code)=([^&#\s]+)/i);
    if (directParamMatch) {
      try {
        return decodeURIComponent(directParamMatch[2])
          .replace(/[，。,.；;！!？?）)\]]+$/g, '')
          .trim();
      } catch (error) {
        return directParamMatch[2].trim();
      }
    }

    try {
      const url = new URL(candidate);
      const taskId =
        url.searchParams.get('taskId') ||
        url.searchParams.get('taskid') ||
        url.searchParams.get('task') ||
        url.searchParams.get('task_code');
      if (taskId) {
        return taskId.replace(/[，。,.；;！!？?）)\]]+$/g, '').trim();
      }
    } catch (error) {
      // Raw task code; continue below.
    }

    return candidate.replace(/[，。,.；;！!？?）)\]]+$/g, '').trim();
  }

  function toDeadlineIso(dateValue) {
    if (!dateValue) return null;
    const date = new Date(`${dateValue}T23:59:59.999`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function getTaskState(task, now = Date.now()) {
    const storedStatus = VALID_TASK_STATUSES.has(task && task.status)
      ? task.status
      : 'active';

    const expiresAt = task && task.expires_at ? new Date(task.expires_at) : null;
    const expired = Boolean(expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < now);

    if (storedStatus === 'closed') {
      return {
        code: 'closed',
        label: '已关闭',
        canPlay: false,
        storedStatus,
        expired
      };
    }

    if (expired) {
      return {
        code: 'expired',
        label: '已过期',
        canPlay: false,
        storedStatus,
        expired: true
      };
    }

    return {
      code: 'active',
      label: '进行中',
      canPlay: true,
      storedStatus,
      expired: false
    };
  }

  async function createTask(payload) {
    const taskCode = payload.task_code || generateTaskCode();
    const normalized = {
      ...payload,
      task_code: taskCode,
      status: VALID_TASK_STATUSES.has(payload.status) ? payload.status : 'active'
    };
    await insert('tasks', normalized);
    return { ...normalized };
  }

  async function loadTask(taskCode) {
    const cleanCode = extractTaskId(taskCode);
    if (!cleanCode) return null;
    return selectOne('tasks', [eqFilter('task_code', cleanCode)], '*');
  }

  async function loadTaskResults(taskCode, order = 'class_name.asc,student_name.asc') {
    const cleanCode = extractTaskId(taskCode);
    if (!cleanCode) return [];
    const query = [
      eqFilter('task_code', cleanCode),
      'select=*',
      `order=${encodeURIComponent(order)}`
    ].join('&');
    return select('task_results', query);
  }

  async function rpc(functionName, payload = {}) {
    const response = await fetch(`${config.url}/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload)
    });
    return parseResponse(response);
  }

  async function updateTaskStatus(taskCode, status) {
    if (!VALID_TASK_STATUSES.has(status)) {
      throw new Error('Invalid task status.');
    }
    const data = await rpc('set_task_status', {
      p_task_code: extractTaskId(taskCode),
      p_status: status
    });
    return Array.isArray(data) ? data[0] || null : data;
  }

  async function submitBestResult({
    task,
    gameKey,
    className = '',
    studentName = '',
    score = 0,
    accuracy = 0,
    durationSeconds = 0,
    resultData = {},
    completedAt = new Date().toISOString()
  }) {
    if (!task || !task.task_code) {
      throw new Error('Task information is missing.');
    }

    const taskState = getTaskState(task);
    if (!taskState.canPlay) {
      throw new Error(taskState.code === 'closed' ? '该任务已关闭。' : '该任务已过期。');
    }

    const filters = [
      eqFilter('task_code', task.task_code),
      eqFilter('game_key', gameKey),
      className ? eqFilter('class_name', className) : isNullFilter('class_name'),
      studentName ? eqFilter('student_name', studentName) : isNullFilter('student_name')
    ];

    const existing = await selectOne(
      'task_results',
      filters,
      'id,attempts,score,accuracy,duration_seconds,result_data,completed_at'
    );

    const basePayload = {
      task_id: task.id || null,
      task_code: task.task_code,
      game_key: gameKey,
      class_name: className || null,
      student_name: studentName || null,
      score,
      accuracy,
      duration_seconds: durationSeconds,
      completed_at: completedAt,
      updated_at: completedAt
    };

    if (!existing) {
      await insert('task_results', {
        ...basePayload,
        attempts: 1,
        result_data: {
          ...resultData,
          bestScore: score,
          bestAccuracy: accuracy,
          bestDurationSeconds: durationSeconds,
          bestCompletedAt: completedAt,
          latestScore: score,
          latestAccuracy: accuracy,
          latestDurationSeconds: durationSeconds,
          latestCompletedAt: completedAt
        }
      });
      return { attempts: 1, bestScore: score, isNewBest: true };
    }

    const previousBestScore = Number(existing.score || 0);
    const latestScore = Number(score || 0);
    const isNewBest = latestScore >= previousBestScore;
    const previousData = existing.result_data && typeof existing.result_data === 'object'
      ? existing.result_data
      : {};
    const attempts = Number(existing.attempts || 1) + 1;

    await updateById('task_results', existing.id, {
      ...basePayload,
      score: isNewBest ? score : existing.score,
      accuracy: isNewBest ? accuracy : existing.accuracy,
      duration_seconds: isNewBest ? durationSeconds : existing.duration_seconds,
      attempts,
      result_data: {
        ...previousData,
        ...resultData,
        bestScore: isNewBest ? score : existing.score,
        bestAccuracy: isNewBest ? accuracy : existing.accuracy,
        bestDurationSeconds: isNewBest ? durationSeconds : existing.duration_seconds,
        bestCompletedAt: isNewBest
          ? completedAt
          : (previousData.bestCompletedAt || existing.completed_at),
        latestScore: score,
        latestAccuracy: accuracy,
        latestDurationSeconds: durationSeconds,
        latestCompletedAt: completedAt
      }
    });

    return {
      attempts,
      bestScore: isNewBest ? score : existing.score,
      isNewBest
    };
  }

  global.TaskSystem = Object.freeze({
    ensureReady,
    headers,
    restUrl,
    eqFilter,
    isNullFilter,
    select,
    selectOne,
    insert,
    updateById,
    rpc,
    generateTaskCode,
    parseStudentList,
    extractTaskId,
    toDeadlineIso,
    getTaskState,
    createTask,
    loadTask,
    loadTaskResults,
    updateTaskStatus,
    submitBestResult
  });
})(window);
