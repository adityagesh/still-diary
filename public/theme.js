(() => {
  const param = new URLSearchParams(window.location.search).get('scoutTheme');
  const theme = param === 'light' || param === 'dark'
    ? param
    : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
})();
