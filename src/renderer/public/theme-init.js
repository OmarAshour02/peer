// Apply a queued offline theme choice before first paint. The durable choice is a server
// preference, which the server stamps onto the served page: a stamped page is authoritative
// unless a choice is explicitly pending. The local mirror only covers dev serving, where
// nothing is stamped.
try {
  var pending = window.localStorage.getItem("peer-theme-pending");
  var chosen = pending || (document.documentElement.dataset.theme ? null : window.localStorage.getItem("peer-theme"));
  if (chosen === "light") document.documentElement.dataset.theme = "light";
  else if (chosen === "dark") delete document.documentElement.dataset.theme;
} catch {}
