/* Injected only after a user action with activeTab permission. It never submits a form. */
(() => {
  if (globalThis.__proximalEditorLoaded) return;
  globalThis.__proximalEditorLoaded = true;
  const api = globalThis.browser ?? globalThis.chrome;

  const aliases = {
    first_name: ['first name', 'given name', 'forename', 'imię', 'imie', 'name'],
    second_name: ['middle name', 'second name', 'drugie imię', 'drugie imie'],
    surname: ['last name', 'family name', 'surname', 'nazwisko'],
    birth_surname: ['maiden name', 'birth surname', 'nazwisko rodowe'],
    birth_date: ['birth date', 'date of birth', 'dob', 'data urodzenia'],
    birth_place: ['birth place', 'place of birth', 'miejsce urodzenia'],
    nationality: ['nationality', 'citizenship', 'obywatelstwo'],
    father_name: ['father name', 'father', 'imię ojca', 'imie ojca'],
    mother_name: ['mother name', 'mother', 'imię matki', 'imie matki'],
    mother_birth_surname: ['mother maiden', 'mother birth surname', 'nazwisko rodowe matki'],
    pesel: ['pesel'],
    id_number: ['id number', 'identity number', 'document number', 'numer dowodu', 'seria i numer'],
    can: ['can number', 'numer can'],
    issue_date: ['issue date', 'date issued', 'data wydania'],
    expiry_date: ['expiry date', 'expiration date', 'valid until', 'data ważności', 'data waznosci'],
    issuer: ['issuer', 'issuing authority', 'organ wydający', 'organ wydajacy'],
    gender: ['gender', 'sex', 'płeć', 'plec']
  };

  function plain(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[_\-]+/g, ' ');
  }

  function fieldText(element) {
    const labels = element.labels ? [...element.labels].map((label) => label.innerText).join(' ') : '';
    return plain([element.name, element.id, element.placeholder, element.getAttribute('aria-label'), labels].join(' '));
  }

  function keyFor(element) {
    const text = fieldText(element);
    let match = null;
    for (const [key, words] of Object.entries(aliases)) {
      if (words.some((word) => text.includes(plain(word)))) {
        if (!match || key !== 'first_name') return key;
        match = key;
      }
    }
    if (element.type === 'email') return null;
    return match;
  }

  function visible(element) {
    const style = getComputedStyle(element);
    return !element.disabled && !element.readOnly && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function setValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value); else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dataset.proximalFilled = 'true';
    element.style.outline = '2px solid #4e9b7a';
    element.style.outlineOffset = '1px';
  }

  function fill(profile) {
    if (!profile || profile.synthetic !== true || !profile.values) {
      return { ok: false, message: 'Brakuje prawidłowego zestawu syntetycznego.' };
    }
    const inputs = [...document.querySelectorAll('input, textarea, select')];
    let filled = 0;
    for (const element of inputs) {
      if (!visible(element) || ['hidden', 'password', 'file', 'submit', 'button', 'reset', 'checkbox', 'radio'].includes(element.type)) continue;
      const key = keyFor(element);
      if (!key || !(key in profile.values)) continue;
      let value = profile.values[key];
      if (element.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) value = value;
      if (element.tagName === 'SELECT') {
        const option = [...element.options].find((item) => plain(item.value) === plain(value) || plain(item.text) === plain(value));
        if (!option) continue;
        element.value = option.value;
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dataset.proximalFilled = 'true';
        filled += 1;
      } else {
        setValue(element, value);
        filled += 1;
      }
    }
    return {
      ok: true,
      filled,
      message: filled ? `Wypełniono ${filled} pól. Formularz nie został wysłany.` : 'Nie znaleziono rozpoznawalnych, edytowalnych pól.'
    };
  }

  api.runtime.onMessage.addListener((message) => message?.type === 'proximal:fill' ? fill(message.profile) : undefined);
})();
