// Notifications: new alerts go to a Google Chat or Slack incoming webhook
// (both accept {"text": ...}). Each alert is sent once; the ids already sent
// are kept for 30 days. Without a webhook, alerts are only logged.
const KEEP_DAYS = 30;
const ICON = { high: '🔴', medium: '🟠', low: '🔵' };

export function alertText(alert) {
  return `${ICON[alert.severity] || '•'} Twin PPC: ${alert.title}\n${alert.detail}`;
}

export async function sendAlerts(cfg, alerts, state, { fetchImpl = fetch, log, now = Date.now() } = {}) {
  const sent = state.alerts.sent || {};
  for (const [id, at] of Object.entries(sent)) if (now - Date.parse(at) > KEEP_DAYS * 86400000) delete sent[id];
  const fresh = alerts.filter((a) => !sent[a.id]);
  const result = { sent: 0, skipped: alerts.length - fresh.length, failed: 0 };
  for (const a of fresh) {
    if (!cfg.alertWebhook) {
      log?.info('alert', { message: `${a.title}: ${a.detail}`, severity: a.severity });
      sent[a.id] = new Date(now).toISOString();
      continue;
    }
    try {
      const res = await fetchImpl(cfg.alertWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: alertText(a) }) });
      if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
      sent[a.id] = new Date(now).toISOString();
      result.sent += 1;
    } catch (e) {
      result.failed += 1;
      log?.warn('alert_not_sent', { message: e.message, alert: a.id });
    }
  }
  state.alerts.sent = sent;
  return result;
}
