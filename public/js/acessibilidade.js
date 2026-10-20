const STORAGE_KEY = 'assisttech-accessibility';
const defaults = { contrast: false, darkMode: false, fontSize: 'normal' };
const controls = {
  contrast: document.querySelector('[data-a11y-contrast]'),
  darkMode: document.querySelector('[data-a11y-theme]')
};
const fontSizeControls = [...document.querySelectorAll('[data-a11y-font-size]')];
const dialog = document.querySelector('#accessibility-dialog');
const openButton = document.querySelector('[data-a11y-open]');
const closeButton = document.querySelector('[data-a11y-close]');

let preferences = { ...defaults };

try {
  const savedPreferences = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  preferences = {
    contrast: savedPreferences.contrast === true,
    darkMode: savedPreferences.darkMode === true,
    fontSize: ['normal', 'medium', 'large'].includes(savedPreferences.fontSize)
      ? savedPreferences.fontSize
      : savedPreferences.largeFont === true ? 'large' : defaults.fontSize
  };
} catch (error) {
  console.warn('Não foi possível carregar as preferências de acessibilidade.', error);
}

const applyPreferences = () => {
  const root = document.documentElement;
  root.dataset.contrast = preferences.contrast ? 'high' : 'normal';
  root.dataset.theme = preferences.darkMode ? 'dark' : 'light';
  root.dataset.fontSize = preferences.fontSize;

  Object.entries(controls).forEach(([preference, button]) => {
    if (button) button.setAttribute('aria-pressed', String(preferences[preference]));
  });

  fontSizeControls.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.a11yFontSize === preferences.fontSize));
  });
};

const togglePreference = (preference) => {
  preferences[preference] = !preferences[preference];
  applyPreferences();

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.warn('Não foi possível salvar as preferências de acessibilidade.', error);
  }
};

controls.contrast?.addEventListener('click', () => togglePreference('contrast'));
controls.darkMode?.addEventListener('click', () => togglePreference('darkMode'));
fontSizeControls.forEach((button) => {
  button.addEventListener('click', () => {
    preferences.fontSize = button.dataset.a11yFontSize;
    applyPreferences();

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch (error) {
      console.warn('Não foi possível salvar as preferências de acessibilidade.', error);
    }
  });
});

openButton?.addEventListener('click', () => dialog?.showModal());
closeButton?.addEventListener('click', () => dialog?.close());
dialog?.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

applyPreferences();
