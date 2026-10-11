/* PrOximAl Editor workspace — self-contained, local-first browser extension UI. */
const api = globalThis.browser ?? globalThis.chrome;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const STORAGE = {
  profile: 'proximal.profile',
  mappings: 'proximal.mappings',
  generator: 'proximal.generator'
};
const NOTICE = 'Dane syntetyczne do testów. Nie potwierdzają tożsamości, nie pochodzą z rejestru i mogą przypadkowo przypominać prawdziwe dane.';
const CITIES = {
  'Warszawa': 'Prezydent m.st. Warszawy', 'Kraków': 'Prezydent Miasta Krakowa', 'Wrocław': 'Prezydent Miasta Wrocławia',
  'Poznań': 'Prezydent Miasta Poznania', 'Gdańsk': 'Prezydent Miasta Gdańska', 'Łódź': 'Prezydent Miasta Łodzi',
  'Szczecin': 'Prezydent Miasta Szczecin', 'Lublin': 'Prezydent Miasta Lublin', 'Katowice': 'Prezydent Miasta Katowice',
  'Białystok': 'Prezydent Miasta Białegostoku', 'Gdynia': 'Prezydent Miasta Gdyni', 'Toruń': 'Prezydent Miasta Torunia',
  'Rzeszów': 'Prezydent Miasta Rzeszowa', 'Olsztyn': 'Prezydent Miasta Olsztyna'
};
const MALE_NAMES = ['Adam', 'Antoni', 'Bartosz', 'Dawid', 'Jan', 'Jakub', 'Kacper', 'Karol', 'Leon', 'Marek', 'Michał', 'Paweł', 'Piotr', 'Tomasz', 'Wojciech'];
const FEMALE_NAMES = ['Alicja', 'Anna', 'Barbara', 'Ewa', 'Hanna', 'Julia', 'Karolina', 'Katarzyna', 'Lena', 'Magdalena', 'Maria', 'Marta', 'Natalia', 'Oliwia', 'Zofia'];
const SURNAMES = { female: ['Adamczyk', 'Baran', 'Dąbrowska', 'Jankowska', 'Kowalska', 'Lewandowska', 'Mazur', 'Nowak', 'Piotrowska', 'Wiśniewska', 'Wójcik', 'Zielińska'], male: ['Adamczyk', 'Baran', 'Dąbrowski', 'Jankowski', 'Kowalski', 'Lewandowski', 'Mazur', 'Nowak', 'Piotrowski', 'Wiśniewski', 'Wójcik', 'Zieliński'] };
const FIELDS = [
  ['first_name', 'Imię', 'Osoba'], ['second_name', 'Drugie imię', 'Osoba'], ['surname', 'Nazwisko', 'Osoba'], ['birth_surname', 'Nazwisko rodowe', 'Osoba'], ['gender', 'Płeć', 'Osoba'], ['age', 'Wiek', 'Osoba'],
  ['birth_date', 'Data urodzenia', 'Urodzenie'], ['birth_place', 'Miejsce urodzenia', 'Urodzenie'], ['nationality', 'Obywatelstwo', 'Urodzenie'],
  ['father_name', 'Imię ojca', 'Rodzina'], ['mother_name', 'Imię matki', 'Rodzina'], ['mother_birth_surname', 'Nazwisko rodowe matki', 'Rodzina'],
  ['pesel', 'PESEL', 'Identyfikatory'], ['id_number', 'Seria i numer testowy', 'Identyfikatory'], ['can', 'Numer CAN testowy', 'Identyfikatory'],
  ['issue_date', 'Data wydania', 'Dokument testowy'], ['expiry_date', 'Data ważności', 'Dokument testowy'], ['issuer', 'Organ wydający', 'Dokument testowy']
];
let profile = null;
let mappings = [];
let copyIndex = 0;
let documentUrl = null;
let studioImage = null;
let studioAngle = 0;
let toastTimer = null;

function randomInt(max) {
  if (!Number.isInteger(max) || max < 1) throw new Error('Nieprawidłowy zakres losowania.');
  const limit = Math.floor(0x100000000 / max) * max;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= limit);
  return value[0] % max;
}
function pick(values) { return values[randomInt(values.length)]; }
function pad(value) { return String(value).padStart(2, '0'); }
function isoDate(day) { return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`; }
function fromIso(value) { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day, 12); }
function today() { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12); }
function addYears(day, years) { const result = new Date(day.getFullYear() + years, day.getMonth(), day.getDate(), 12); if (result.getMonth() !== day.getMonth()) result.setDate(0); return result; }
function ageOn(birth, on) { return on.getFullYear() - birth.getFullYear() - (on.getMonth() < birth.getMonth() || (on.getMonth() === birth.getMonth() && on.getDate() < birth.getDate()) ? 1 : 0); }
function dateRange(from, to) { return new Date(from.getTime() + randomInt(Math.floor((to - from) / 86400000) + 1) * 86400000); }
function formatDate(iso, options = profile?.options) { if (!iso) return ''; if (options?.dateFormat === 'pl') { const [year, month, day] = iso.split('-'); return `${day}.${month}.${year}`; } return iso; }
function displayValue(key, value) { const raw = ['birth_date', 'issue_date', 'expiry_date'].includes(key) ? formatDate(value) : value; return profile?.options?.uppercase ? raw.toLocaleUpperCase('pl-PL') : raw; }
function safeText(value) { return String(value).replace(/[&<>'"]/g, (letter) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[letter])); }
function csvCell(value) { const text = String(value); const safe = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text; return `"${safe.replaceAll('"', '""')}"`; }
async function readStorage(keys) { return api.storage.local.get(keys); }
async function writeStorage(values) { return api.storage.local.set(values); }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3500); }

async function copy(text, message = 'Skopiowano do schowka.') {
  try { await navigator.clipboard.writeText(text); } catch (_) {
    const field = document.createElement('textarea'); field.value = text; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select(); document.execCommand('copy'); field.remove();
  }
  $('#copy-status').textContent = message;
  toast(message);
}
function download(name, content, type = 'application/json;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function populateCities() { $('#profile-city').innerHTML = Object.keys(CITIES).map((city) => `<option>${safeText(city)}</option>`).join(''); }
function activeView() { return location.hash.slice(1) || 'start'; }
function showView(view, updateHash = true) {
  const safeView = $(`#view-${CSS.escape(view)}`) ? view : 'start';
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${safeView}`));
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === safeView));
  if (updateHash && location.hash !== `#${safeView}`) history.replaceState(null, '', `#${safeView}`);
  document.title = `${safeView === 'start' ? 'PrOximAl Editor' : `${$('.nav-button.active')?.textContent || 'PrOximAl'} — PrOximAl Editor`}`;
}

function updateSession() {
  $('#session-profile').textContent = profile?.synthetic ? `${profile.values.first_name} ${profile.values.surname}` : 'brak';
  $('#session-document').textContent = $('#document-name').textContent === 'Nie wybrano pliku' ? 'brak' : $('#document-name').textContent;
  $('#session-mapping').textContent = String(mappings.length);
}
function populateGenerator(options = {}) {
  $('#profile-gender').value = options.gender || 'random'; $('#profile-min-age').value = options.minAge ?? 18; $('#profile-max-age').value = options.maxAge ?? 45;
  $('#profile-city').value = options.city || 'Warszawa'; $('#profile-date-format').value = options.dateFormat || 'pl'; $('#profile-second-name').checked = Boolean(options.secondName); $('#profile-upper').checked = Boolean(options.uppercase);
}
function generatorOptions() {
  return {
    gender: $('#profile-gender').value, minAge: Number($('#profile-min-age').value), maxAge: Number($('#profile-max-age').value), city: $('#profile-city').value,
    dateFormat: $('#profile-date-format').value, secondName: $('#profile-second-name').checked, uppercase: $('#profile-upper').checked
  };
}
function validateOptions(options) {
  if (!Number.isInteger(options.minAge) || !Number.isInteger(options.maxAge) || options.minAge < 0 || options.maxAge > 120 || options.minAge > options.maxAge) throw new Error('Wiek musi należeć do zakresu 0–120, a wartość „od” nie może być większa od „do”.');
  if (!CITIES[options.city]) throw new Error('Wybierz miasto z listy.');
}
function peselFor(birth, gender) {
  const centuryOffset = { 18: 80, 19: 0, 20: 20, 21: 40, 22: 60 }[Math.floor(birth.getFullYear() / 100)];
  const first = `${String(birth.getFullYear() % 100).padStart(2, '0')}${String(birth.getMonth() + 1 + centuryOffset).padStart(2, '0')}${pad(birth.getDate())}${String(randomInt(1000)).padStart(3, '0')}${randomInt(5) * 2 + (gender === 'male' ? 1 : 0)}`;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]; const checksum = (10 - [...first].reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0) % 10) % 10;
  return `${first}${checksum}`;
}
function testDocumentNumber() {
  // QA marker makes this unsuitable as an identity-document number, unlike desktop legacy fixtures.
  return `QA-${String(randomInt(1000000)).padStart(6, '0')}`;
}
function generateProfile(options) {
  validateOptions(options); const now = today(); const gender = options.gender === 'random' ? pick(['female', 'male']) : options.gender;
  const latestBirth = addYears(now, -options.minAge); const earliestBirth = addYears(now, -options.maxAge - 1); earliestBirth.setDate(earliestBirth.getDate() + 1);
  const birth = dateRange(earliestBirth, latestBirth); const earliestIssue = new Date(Math.max(birth.getTime(), addYears(now, -4).getTime())); const issue = dateRange(earliestIssue, now); const expiry = addYears(issue, ageOn(birth, issue) < 12 ? 5 : 10);
  const given = gender === 'female' ? FEMALE_NAMES : MALE_NAMES; const surname = pick(SURNAMES[gender]); const otherSurname = pick(SURNAMES[gender].filter((item) => item !== surname));
  const values = {
    first_name: pick(given), second_name: options.secondName ? pick(given) : '', surname, birth_surname: surname, gender: gender === 'female' ? 'Kobieta' : 'Mężczyzna', age: String(ageOn(birth, now)),
    birth_date: isoDate(birth), birth_place: pick(Object.keys(CITIES)), nationality: 'Polskie', father_name: pick(MALE_NAMES), mother_name: pick(FEMALE_NAMES), mother_birth_surname: otherSurname,
    pesel: peselFor(birth, gender), id_number: testDocumentNumber(), can: `QA${String(randomInt(100000)).padStart(5, '0')}`, issue_date: isoDate(issue), expiry_date: isoDate(expiry), issuer: CITIES[options.city]
  };
  return { format: 'PrOximAl-DaneGen/Browser-1', synthetic: true, createdAt: new Date().toISOString(), asOf: isoDate(now), notice: NOTICE, options, values };
}
function profileCsv() {
  const rows = [['synthetic', 'as_of', 'grupa', 'pole', 'wartość']];
  for (const [key, label, group] of FIELDS) rows.push(['true', profile.asOf, group, label, displayValue(key, profile.values[key])]);
  return rows.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
function profileText() { return FIELDS.filter(([key]) => profile.values[key]).map(([key, label]) => `${label}: ${displayValue(key, profile.values[key])}`).join('\n'); }
function renderProfile() {
  const ready = profile?.synthetic;
  $('#profile-title').textContent = ready ? `${profile.values.first_name} ${profile.values.surname}` : 'Brak zestawu';
  $('#profile-notice').textContent = ready ? profile.notice : 'Wygeneruj zestaw. Wszystkie wartości będą wyraźnie oznaczone jako syntetyczne.';
  $('#profile-fields').innerHTML = ready ? FIELDS.filter(([key]) => profile.values[key]).map(([key, label, group]) => `<tr><td>${safeText(group)}</td><td>${safeText(label)}</td><td>${safeText(displayValue(key, profile.values[key]))}</td><td><button class="copy-field" data-copy-key="${key}" aria-label="Kopiuj ${safeText(label)}">Kopiuj</button></td></tr>`).join('') : '<tr><td colspan="4" class="subtle">Nie wygenerowano jeszcze danych.</td></tr>';
  ['#copy-next', '#copy-profile', '#download-profile-json', '#download-profile-csv', '#fill-current-form'].forEach((selector) => { $(selector).disabled = !ready; });
  updateSession();
}
async function persistProfile() { await writeStorage({ [STORAGE.profile]: profile, [STORAGE.generator]: profile?.options || generatorOptions() }); }
async function createNewProfile() {
  try { profile = generateProfile(generatorOptions()); copyIndex = 0; await persistProfile(); renderProfile(); toast('Utworzono nowy, syntetyczny zestaw testowy.'); } catch (error) { toast(error.message); }
}

function renderMappings() {
  $('#mapping-count').textContent = String(mappings.length); $('#mapping-list').innerHTML = mappings.length ? mappings.map((item, index) => `<div class="mapping-row"><strong>${safeText(item.original)}</strong><span>${safeText(item.replacement)}</span>${item.note ? `<small>${safeText(item.note)}</small>` : ''}<button class="remove-row" data-remove-mapping="${index}" aria-label="Usuń wpis">×</button></div>`).join('') : '<p class="subtle">Brak pozycji. Dodaj pierwszą planowaną podmianę.</p>';
  updateSession();
}
async function persistMappings() { await writeStorage({ [STORAGE.mappings]: mappings }); }
async function addMapping(event) {
  event.preventDefault(); const original = $('#mapping-original').value.trim(); const replacement = $('#mapping-replacement').value.trim(); const note = $('#mapping-note').value.trim(); if (!original || !replacement) return;
  mappings.unshift({ original, replacement, note, createdAt: new Date().toISOString() }); await persistMappings(); event.target.reset(); renderMappings(); toast('Dodano pozycję do mapy zmian.');
}
function mappingCsv() { return [['original', 'replacement', 'note', 'created_at'], ...mappings.map((item) => [item.original, item.replacement, item.note, item.createdAt])].map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n'; }

function formatBytes(bytes) { if (!Number.isFinite(bytes)) return '—'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`; return `${(bytes / 1048576).toFixed(1)} MB`; }
function clearDocumentPreview() { if (documentUrl) URL.revokeObjectURL(documentUrl); documentUrl = null; }
function importDocument(file) {
  if (!file || !(/^(application\/pdf|image\/(png|jpeg|webp))$/).test(file.type)) { toast('Wybierz plik PDF, PNG, JPEG lub WebP.'); return; }
  clearDocumentPreview(); documentUrl = URL.createObjectURL(file); const preview = $('#document-preview'); preview.classList.remove('empty'); preview.textContent = '';
  const element = file.type === 'application/pdf' ? document.createElement('iframe') : new Image(); element.src = documentUrl; element.title = `Lokalny podgląd: ${file.name}`; if (element instanceof HTMLImageElement) element.alt = `Lokalny podgląd ${file.name}`; preview.append(element);
  $('#document-name').textContent = file.name; $('#document-details').textContent = `${file.type === 'application/pdf' ? 'PDF' : 'obraz'} · ${formatBytes(file.size)}`; updateSession(); toast('Plik otwarto wyłącznie w lokalnym podglądzie.');
}
function setupDropzone(zoneSelector, callback) {
  const zone = $(zoneSelector); ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (event) => { event.preventDefault(); zone.classList.add('dragover'); })); ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (event) => { event.preventDefault(); zone.classList.remove('dragover'); })); zone.addEventListener('drop', (event) => callback(event.dataTransfer.files[0]));
}

function canvasSettings() { return { brightness: Number($('#brightness').value), contrast: Number($('#contrast').value), grayscale: $('#grayscale').checked }; }
function drawStudioImage() {
  const canvas = $('#image-canvas'); const context = canvas.getContext('2d'); if (!studioImage) { canvas.width = 800; canvas.height = 520; context.clearRect(0, 0, canvas.width, canvas.height); $('#image-empty').hidden = false; return; }
  const side = studioAngle % 180 !== 0; canvas.width = side ? studioImage.height : studioImage.width; canvas.height = side ? studioImage.width : studioImage.height; const settings = canvasSettings(); context.save(); context.filter = `brightness(${settings.brightness}%) contrast(${settings.contrast}%) grayscale(${settings.grayscale ? 100 : 0}%)`; context.translate(canvas.width / 2, canvas.height / 2); context.rotate(studioAngle * Math.PI / 180); context.drawImage(studioImage, -studioImage.width / 2, -studioImage.height / 2); context.restore(); $('#image-empty').hidden = true;
}
function importStudioImage(file) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('Wybierz obraz PNG, JPEG lub WebP.'); return; }
  const url = URL.createObjectURL(file); const image = new Image(); image.onload = () => { URL.revokeObjectURL(url); const max = 2200; if (Math.max(image.naturalWidth, image.naturalHeight) > max) { const scaled = document.createElement('canvas'); const ratio = max / Math.max(image.naturalWidth, image.naturalHeight); scaled.width = Math.round(image.naturalWidth * ratio); scaled.height = Math.round(image.naturalHeight * ratio); scaled.getContext('2d').drawImage(image, 0, 0, scaled.width, scaled.height); const smaller = new Image(); smaller.onload = () => { studioImage = smaller; studioAngle = 0; drawStudioImage(); }; smaller.src = scaled.toDataURL('image/png'); toast('Duży obraz zmniejszono tylko w pamięci do podglądu.'); } else { studioImage = image; studioAngle = 0; drawStudioImage(); toast('Obraz otwarto lokalnie.'); } }; image.onerror = () => { URL.revokeObjectURL(url); toast('Nie można odczytać tego obrazu.'); }; image.src = url;
}
function resetStudioImage() { $('#brightness').value = 100; $('#contrast').value = 100; $('#grayscale').checked = false; studioAngle = 0; updateStudioOutputs(); drawStudioImage(); }
function updateStudioOutputs() { $('#brightness-output').value = `${$('#brightness').value}%`; $('#contrast-output').value = `${$('#contrast').value}%`; }

async function fillCurrentForm() {
  if (!profile?.synthetic) { toast('Najpierw utwórz zestaw syntetyczny.'); return; }
  try { const result = await api.runtime.sendMessage({ type: 'proximal:fill-active' }); toast(result?.message || 'Gotowe.'); } catch (_) { toast('Nie można połączyć się z kartą. Otwórz zwykłą stronę formularza i spróbuj ponownie.'); }
}

function wireEvents() {
  $$('.nav-button').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.go)));
  $$('[data-view-link]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); showView(link.dataset.viewLink); }));
  window.addEventListener('hashchange', () => showView(activeView(), false));
  $('#generator-form').addEventListener('submit', (event) => { event.preventDefault(); createNewProfile(); });
  $('#profile-fields').addEventListener('click', (event) => { const key = event.target.dataset.copyKey; if (key && profile) copy(displayValue(key, profile.values[key]), `Skopiowano: ${FIELDS.find(([id]) => id === key)[1]}.`); });
  $('#copy-next').addEventListener('click', () => { if (!profile) return; const available = FIELDS.filter(([key]) => profile.values[key]); const item = available[copyIndex % available.length]; copyIndex += 1; copy(displayValue(item[0], profile.values[item[0]]), `Skopiowano: ${item[1]}.`); });
  $('#copy-profile').addEventListener('click', () => profile && copy(profileText(), 'Skopiowano cały zestaw.'));
  $('#download-profile-json').addEventListener('click', () => profile && download('proximal-synthetic-profile.json', JSON.stringify(profile, null, 2)));
  $('#download-profile-csv').addEventListener('click', () => profile && download('proximal-synthetic-profile.csv', profileCsv(), 'text/csv;charset=utf-8'));
  $('#fill-current-form').addEventListener('click', fillCurrentForm);
  $('#mapping-form').addEventListener('submit', addMapping); $('#mapping-list').addEventListener('click', async (event) => { const index = event.target.dataset.removeMapping; if (index === undefined) return; mappings.splice(Number(index), 1); await persistMappings(); renderMappings(); });
  $('#clear-mapping').addEventListener('click', async () => { if (!mappings.length || !confirm('Usunąć całą mapę zmian?')) return; mappings = []; await persistMappings(); renderMappings(); toast('Usunięto mapę zmian.'); });
  $('#export-mapping-json').addEventListener('click', () => download('proximal-change-map.json', JSON.stringify({ format: 'PrOximAl-change-map/1', createdAt: new Date().toISOString(), replacements: mappings }, null, 2)));
  $('#export-mapping-csv').addEventListener('click', () => download('proximal-change-map.csv', mappingCsv(), 'text/csv;charset=utf-8'));
  $('#document-input').addEventListener('change', (event) => importDocument(event.target.files[0])); setupDropzone('#document-drop', importDocument);
  $('#image-input').addEventListener('change', (event) => importStudioImage(event.target.files[0])); setupDropzone('#image-drop', importStudioImage);
  ['#brightness', '#contrast', '#grayscale'].forEach((selector) => $(selector).addEventListener('input', () => { updateStudioOutputs(); drawStudioImage(); }));
  $('#rotate-left').addEventListener('click', () => { if (studioImage) { studioAngle = (studioAngle + 270) % 360; drawStudioImage(); } }); $('#rotate-right').addEventListener('click', () => { if (studioImage) { studioAngle = (studioAngle + 90) % 360; drawStudioImage(); } });
  $('#reset-image').addEventListener('click', resetStudioImage); $('#download-image').addEventListener('click', () => { if (!studioImage) return toast('Najpierw otwórz obraz.'); $('#image-canvas').toBlob((blob) => blob && download('proximal-local-preview.png', blob, 'image/png'), 'image/png'); });
  $('#clear-local-data').addEventListener('click', async () => { if (!confirm('Usunąć aktywny profil, mapę zmian i ustawienia PrOximAl?')) return; await api.storage.local.remove(Object.values(STORAGE)); profile = null; mappings = []; copyIndex = 0; populateGenerator(); renderProfile(); renderMappings(); $('#clear-status').textContent = 'Usunięto lokalny stan dodatku.'; toast('Lokalny stan został usunięty.'); });
  window.addEventListener('beforeunload', clearDocumentPreview);
}
async function init() {
  populateCities(); const stored = await readStorage(Object.values(STORAGE)); profile = stored[STORAGE.profile]?.synthetic ? stored[STORAGE.profile] : null; mappings = Array.isArray(stored[STORAGE.mappings]) ? stored[STORAGE.mappings].filter((item) => item && typeof item.original === 'string' && typeof item.replacement === 'string') : [];
  populateGenerator(stored[STORAGE.generator] || profile?.options); updateStudioOutputs(); drawStudioImage(); renderProfile(); renderMappings(); wireEvents(); showView(activeView(), false);
}
init().catch((error) => { console.error(error); toast('Nie udało się uruchomić przestrzeni. Odśwież kartę rozszerzenia.'); });
