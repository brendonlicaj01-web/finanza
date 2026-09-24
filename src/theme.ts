export type Theme = 'auto' | 'light' | 'dark';

const KEY = 'finanza:theme';

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

export function setTheme(t: Theme) {
  try {
    if (t === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // preferenza non persistita: il tema resta valido per la sessione
  }
  applyTheme(t);
}

export function applyTheme(t: Theme = getTheme()) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
