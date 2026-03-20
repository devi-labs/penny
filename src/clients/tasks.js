'use strict';

const { google } = require('googleapis');

function createTasksClient({ clientId, clientSecret, refreshToken, defaultListId }) {
  if (!clientId || !clientSecret || !refreshToken) return null;

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });

  const tasks = google.tasks({ version: 'v1', auth: oauth2 });
  const defaultTasklist = defaultListId || '@default';

  async function listTaskLists() {
    const res = await tasks.tasklists.list({ maxResults: 100 });
    return (res.data.items || []).map(tl => ({
      id: tl.id,
      title: tl.title || '(untitled)',
    }));
  }

  async function listTasks({ tasklist, maxResults = 100, showCompleted = false } = {}) {
    const res = await tasks.tasks.list({
      tasklist: tasklist || defaultTasklist,
      maxResults,
      showCompleted,
      showHidden: false,
    });

    return (res.data.items || []).map(t => ({
      id: t.id,
      title: t.title || '(untitled)',
      notes: t.notes || '',
      due: t.due || '',
      status: t.status || 'needsAction',
      completed: t.status === 'completed',
    }));
  }

  async function addTask({ title, notes, due, tasklist }) {
    const body = { title };
    if (notes) body.notes = notes;
    if (due) body.due = new Date(due).toISOString();

    const res = await tasks.tasks.insert({
      tasklist: tasklist || defaultTasklist,
      requestBody: body,
    });

    return {
      id: res.data.id,
      title: res.data.title,
    };
  }

  async function completeTask(taskId, tasklist) {
    const res = await tasks.tasks.patch({
      tasklist: tasklist || defaultTasklist,
      task: taskId,
      requestBody: { status: 'completed' },
    });

    return { id: res.data.id, title: res.data.title };
  }

  async function deleteTask(taskId, tasklist) {
    await tasks.tasks.delete({
      tasklist: tasklist || defaultTasklist,
      task: taskId,
    });
  }

  return { listTaskLists, listTasks, addTask, completeTask, deleteTask, enabled: true };
}

module.exports = { createTasksClient };
