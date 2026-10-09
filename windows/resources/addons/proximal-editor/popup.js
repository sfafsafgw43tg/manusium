const api = globalThis.browser ?? globalThis.chrome;
const $ = (selector) => document.querySelector(selector);

async function refreshProfileState() {
  const data = await api.storage.local.get('proximal.profile');
  const profile = data['proximal.profile'];
  $('#profile-state').textContent = profile?.synthetic
    ? `Aktywny zestaw: ${profile.values.first_name} ${profile.values.surname} (syntetyczny)`
    : 'Brak aktywnego zestawu testowego — utwórz go w przestrzeni.';
  $('#fill-form').disabled = !profile?.synthetic;
}

$('#open-workspace').addEventListener('click', () => api.runtime.sendMessage({ type: 'proximal:open' }).then(() => window.close()));
$('#fill-form').addEventListener('click', async () => {
  $('#popup-status').textContent = 'Wypełniam…';
  const result = await api.runtime.sendMessage({ type: 'proximal:fill-active' });
  $('#popup-status').textContent = result?.message || 'Gotowe.';
  if (result?.ok) setTimeout(() => window.close(), 850);
});
refreshProfileState().catch(() => { $('#profile-state').textContent = 'Nie można odczytać stanu rozszerzenia.'; });
