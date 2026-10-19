// The admin dashboard: getting in (account page sign-in, then an emailed code), then the views
// in the sidebar (#overview, #accounts, #computers, #trials, #licences) and one account's
// detail with its actions. People's names and emails are only ever shown as text, never HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const make = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k != null && k !== false));
    return node;
  };
  const DAY = 86400;
  const nowSec = () => Date.now() / 1000;
  const date = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const ago = (unix) => {
    if (!unix) return "never";
    const days = Math.floor((nowSec() - unix) / DAY);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days} days ago` : date(unix);
  };
  const pill = (text, kind) => make("span", { className: `pill ${kind}`, textContent: text });

  async function api(method, body) {
    const res = await fetch("/api/admin", { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body && JSON.stringify(body), credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? "That didn’t work. Try again."), { status: res.status });
    return data;
  }
  async function busy(msg, fn) {
    msg.textContent = "One moment…";
    try {
      await fn();
    } catch (e) {
      msg.textContent = e instanceof TypeError ? "Couldn’t reach the server. Check your connection and try again." : e.message;
      if (e.status === 401) gate();
    }
  }

  // ---- getting in ----
  let me = "";
  /** Whether an authenticator app is set up, and which second step is showing. */
  let hasApp = false;
  let method = "email";
  function setMethod(m) {
    method = m;
    $("by-app").hidden = m !== "app";
    $("by-email").hidden = m !== "email";
    $("use-email").hidden = !(hasApp && m === "app");
    $("use-app").hidden = !(hasApp && m === "email");
    const ready = m === "app" || !$("code-entry").hidden;
    $("trust-row").hidden = !ready;
    $("open").hidden = !ready;
    $("code-msg").textContent = "";
    if (m === "app") $("app-code").focus();
  }
  async function gate() {
    const s = await api("POST", { action: "status" }).catch(() => ({}));
    me = s.email ?? "";
    hasApp = !!s.totp;
    if (s.verified) return load();
    $("shell").hidden = true;
    $("gate").hidden = false;
    $("gate-account").hidden = s.signedIn;
    $("code-form").hidden = !s.admin;
    $("gate-text").textContent = !s.signedIn
      ? "Sign in on the account page with an admin email first, then come back here."
      : !s.admin
        ? `${s.email} isn’t an admin. Sign in on the account page with an admin email.`
        : hasApp
          ? "Enter the code from your authenticator app."
          : `To open the dashboard, we’ll email a 6-digit code to ${s.email}.`;
    if (s.admin) setMethod(hasApp ? "app" : "email");
  }
  $("use-email").onclick = () => setMethod("email");
  $("use-app").onclick = () => setMethod("app");
  $("send-code").onclick = () =>
    busy($("code-msg"), async () => {
      await api("POST", { action: "code" });
      $("code-entry").hidden = false;
      $("send-code").textContent = "Send another code";
      setMethod("email");
      $("code").focus();
      $("code-msg").textContent = "Sent. It expires in 10 minutes.";
    });
  $("code-form").onsubmit = (e) => {
    e.preventDefault();
    const code = method === "app" ? $("app-code").value : $("code").value;
    busy($("code-msg"), async () => show(await api("POST", { action: "verify", method, code, trust: $("trust").checked })));
  };
  $("admin-out").onclick = async () => {
    await api("POST", { action: "logout" }).catch(() => {});
    gate();
  };
  $("refresh").onclick = () => load();

  // ---- the sidebar and views ----
  const TITLES = { overview: "Overview", accounts: "Accounts", computers: "Computers", trials: "Trials", licences: "Licences", security: "Security" };
  function route() {
    const view = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : "overview";
    document.querySelectorAll("#views > section").forEach((s) => (s.hidden = s.dataset.view !== view));
    document.querySelectorAll(".sidebar nav a").forEach((a) => (a.dataset.view === view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    $("title").textContent = TITLES[view];
    document.title = `${TITLES[view]} · Admin · Hearken Studio`;
    menu(false);
    scrollTo(0, 0);
  }
  addEventListener("hashchange", route);
  const menu = (open) => {
    $("shell").classList.toggle("menu-open", open);
    $("burger").setAttribute("aria-expanded", open);
  };
  $("burger").onclick = () => menu(!$("shell").classList.contains("menu-open"));
  $("scrim").onclick = () => menu(false);
  addEventListener("keydown", (e) => e.key === "Escape" && menu(false));

  // ---- data ----
  let data = null;
  const load = () => api("GET").then(show, gate);

  function show(o) {
    data = o;
    $("gate").hidden = true;
    $("shell").hidden = false;
    $("me").textContent = me;
    $("updated").textContent = `Updated ${new Date(o.generated * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    overview(o);
    accountsView();
    computersView();
    trialsView();
    licencesView();
    security();
    route();
  }

  const tile = (label, value, sub, href) => make(href ? "a" : "div", { className: "tile", ...(href ? { href } : {}) }, make("span", { textContent: label }), make("b", { textContent: String(value) }), make("small", { textContent: sub }));
  function bars(el, weeks) {
    const top = Math.max(1, ...weeks.map((w) => w.count));
    el.replaceChildren(...weeks.map((w) => make("div", { className: "bar", title: `Week of ${date(w.week)}: ${w.count}` }, make("i", { style: `height:${Math.max(2, (w.count / top) * 100)}%` }), make("span", { textContent: w.count || "" }))));
  }

  function status(a) {
    if (a.licence) return a.licence.state === "active" ? pill(`Licensed until ${date(a.licence.expires)}`, "good") : a.licence.state === "grace" ? pill("Licence in grace", "gold") : pill("Licence ended", "bad");
    if (a.trialEnds) return a.trialEnds > nowSec() ? pill(`Trial until ${date(a.trialEnds)}`, "gold") : pill("Trial ended", "bad");
    return pill(a.computers ? "Trial not registered" : "No computers yet", "muted");
  }
  const churchCell = (a) => {
    const open = make("button", { type: "button", className: "link", textContent: a.church });
    open.onclick = () => openDetail(a.email);
    return make("td", {}, open, a.admin && make("span", { className: "tag", textContent: "admin" }));
  };
  const emptyRow = (cols, text) => make("tr", { className: "empty" }, make("td", { colSpan: cols, textContent: text }));

  function overview(o) {
    const s = o.stats;
    $("tiles").replaceChildren(
      tile("Accounts", s.accounts, `${s.accountsWeek} new this week · ${s.accountsMonth} this month`, "#accounts"),
      tile("Computers signed in", s.computers, `${s.activeToday} used today · ${s.activeWeek} this week`, "#computers"),
      tile("Trials running", s.trialsActive, `${s.trials - s.trialsActive} ended · ${s.trialsWeek} new this week`, "#trials"),
      tile("Active licences", s.licencesActive, `${s.licencesGrace} in grace · ${s.licencesEnded} ended`, "#licences"),
      tile("Emails unconfirmed", s.unverified, "accounts from before email codes", "#accounts"),
    );
    bars($("chart-accounts"), o.weeks.accounts);
    bars($("chart-trials"), o.weeks.trials);
    $("recent").replaceChildren(...(o.accounts.length ? o.accounts.slice(0, 6).map((a) => make("tr", {}, churchCell(a), make("td", {}, make("small", { textContent: a.email })), make("td", {}, status(a)))) : [emptyRow(3, "No accounts yet.")]));
    $("versions").replaceChildren(...(o.versions.length ? o.versions.map((v) => make("li", {}, make("span", { textContent: `v${v.version}` }), make("b", { textContent: String(v.n) }))) : [make("li", { className: "hint", textContent: "No trials registered yet." })]));
  }

  // Accounts, with a search box and filters.
  const FILTERS = {
    all: ["All", () => true],
    licensed: ["Licensed", (a) => a.licence?.state === "active"],
    trial: ["On trial", (a) => !a.licence && a.trialEnds > nowSec()],
    ended: ["Trial ended", (a) => !a.licence && a.trialEnds && a.trialEnds <= nowSec()],
    unverified: ["Email unconfirmed", (a) => !a.verified],
  };
  let filter = "all";
  function accountsView() {
    $("chips").replaceChildren(
      ...Object.entries(FILTERS).map(([key, [label, test]]) => {
        const b = make("button", { type: "button", "aria-pressed": key === filter }, label, make("small", { textContent: String(data.accounts.filter(test).length) }));
        b.setAttribute("aria-pressed", key === filter);
        b.onclick = () => { filter = key; accountsView(); };
        return b;
      }),
    );
    const q = $("q-accounts").value.trim().toLowerCase();
    const list = data.accounts.filter(FILTERS[filter][1]).filter((a) => !q || `${a.church} ${a.email}`.toLowerCase().includes(q));
    $("accounts").replaceChildren(
      ...(list.length
        ? list.map((a) =>
            make("tr", {},
              churchCell(a),
              make("td", {}, a.email, !a.verified && make("small", { textContent: "email unconfirmed" })),
              make("td", { textContent: date(a.created) }),
              make("td", { textContent: String(a.computers) }),
              make("td", { textContent: ago(a.lastUsed) }),
              make("td", {}, status(a)),
            ),
          )
        : [emptyRow(6, q || filter !== "all" ? "No accounts match." : "No accounts yet.")]),
    );
  }
  $("q-accounts").oninput = accountsView;

  function computersView() {
    const q = $("q-computers").value.trim().toLowerCase();
    const list = data.computers.filter((c) => !q || `${c.name} ${c.church} ${c.email}`.toLowerCase().includes(q));
    $("computers").replaceChildren(
      ...(list.length
        ? list.map((c) => {
            const open = make("button", { type: "button", className: "link", textContent: c.church });
            open.onclick = () => openDetail(c.email);
            const trial = c.trialEnds ? (c.trialEnds > nowSec() ? pill(`until ${date(c.trialEnds)}`, "gold") : pill("ended", "bad")) : pill("not registered", "muted");
            return make("tr", {}, make("td", {}, make("b", { textContent: c.name })), make("td", {}, open), make("td", { textContent: date(c.first) }), make("td", { textContent: ago(c.last) }), make("td", {}, trial));
          })
        : [emptyRow(5, q ? "No computers match." : "No computers signed in yet.")]),
    );
  }
  $("q-computers").oninput = computersView;

  function trialsView() {
    $("trials").replaceChildren(
      ...(data.trials.length
        ? data.trials.map((t) => {
            let who = make("td", { className: "hint", textContent: "Not signed in" });
            if (t.church) {
              const open = make("button", { type: "button", className: "link", textContent: t.church });
              open.onclick = () => openDetail(t.email);
              who = make("td", {}, open);
            }
            return make("tr", {},
              make("td", {}, make("code", { textContent: t.id.slice(0, 8) })),
              who,
              make("td", { textContent: t.version ? `v${t.version}` : "—" }),
              make("td", { textContent: date(t.starts) }),
              make("td", {}, t.ends > nowSec() ? pill(`until ${date(t.ends)}`, "gold") : pill(`ended ${date(t.ends)}`, "bad")),
            );
          })
        : [emptyRow(5, "No trials registered yet.")]),
    );
  }

  function licencesView() {
    const licensed = data.accounts.filter((a) => a.licence);
    $("licences").replaceChildren(
      ...(licensed.length
        ? licensed.map((a) => make("tr", {}, churchCell(a), make("td", { textContent: a.licence.plan }), make("td", { textContent: date(a.licence.expires) }), make("td", {}, status(a))))
        : [emptyRow(4, "No licences issued yet.")]),
    );
    $("log").replaceChildren(
      ...(data.log.length
        ? data.log.map((e) =>
            make("li", {},
              make("span", { textContent: `${e.action === "issued" ? `Issued ${e.plan} until ${date(e.expires)}` : e.action === "revoked" ? "Revoked the licence" : "Deleted the account"} · ${e.church}` }),
              make("small", { textContent: `${date(e.at)} · ${e.by}` }),
            ),
          )
        : [make("li", { className: "hint", textContent: "Nothing yet." })]),
    );
  }

  // ---- security: the authenticator app ----
  async function security() {
    const s = await api("POST", { action: "status" }).catch(() => null);
    if (!s) return;
    hasApp = !!s.totp;
    $("totp-state").textContent = hasApp
      ? "On. Signing in asks for a code from your authenticator app instead of an email."
      : "Off. Signing in uses a code emailed to you. Set up an authenticator app to sign in without waiting for an email.";
    $("totp-begin").hidden = hasApp || !$("totp-setup").hidden;
    $("totp-remove").hidden = !hasApp;
  }
  $("totp-begin").onclick = () =>
    busy($("totp-msg"), async () => {
      const r = await api("POST", { action: "totpBegin" });
      const qr = qrcode(0, "M");
      qr.addData(r.uri);
      qr.make();
      $("totp-qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      $("totp-secret").textContent = r.secret.match(/.{1,4}/g).join(" ");
      $("totp-setup").hidden = false;
      $("totp-begin").hidden = true;
      $("totp-msg").textContent = "";
      $("totp-code").focus();
    });
  $("totp-confirm").onsubmit = (e) => {
    e.preventDefault();
    busy($("totp-msg"), async () => {
      await api("POST", { action: "totpConfirm", code: $("totp-code").value });
      $("totp-setup").hidden = true;
      $("totp-code").value = "";
      await security();
      $("totp-msg").textContent = "Your authenticator app is on. Next time, sign in with its code.";
    });
  };
  $("totp-remove").onsubmit = (e) => {
    e.preventDefault();
    if (!confirm("Remove the authenticator app? Signing in will use emailed codes again.")) return;
    busy($("totp-msg"), async () => {
      await api("POST", { action: "totpRemove", code: $("totp-remove-code").value });
      $("totp-remove-code").value = "";
      await security();
      $("totp-msg").textContent = "Removed. Signing in uses emailed codes again.";
    });
  };

  // ---- one account ----
  let current = null;
  const dialog = $("detail");
  async function openDetail(email) {
    $("d-msg").textContent = "";
    $("d-confirm").value = "";
    try {
      fill(await api("POST", { action: "account", email }));
      dialog.showModal();
    } catch (e) {
      alert(e.message);
    }
  }
  function fill(d) {
    current = d;
    $("d-church").textContent = d.church;
    $("d-who").textContent = `${d.email}${d.verified ? "" : " (email unconfirmed)"} · account since ${date(d.created)}${d.admin ? " · admin" : ""}`;
    $("d-name").value = d.church;
    $("d-licence").textContent = d.licence ? `${d.licence.plan} plan, until ${date(d.licence.expires)}.` : "No licence: its computers are on their free trials.";
    $("d-revoke").hidden = !d.licence;
    $("d-computers").replaceChildren(
      ...(d.computers.length
        ? d.computers.map((c) => {
            const out = make("button", { type: "button", className: "btn ghost small", textContent: "Sign out" });
            out.onclick = () => act({ action: "remove", id: c.id }, `“${c.name}” is signed out.`);
            const trial = c.trialEnds ? ` · trial ${c.trialEnds > nowSec() ? "until" : "ended"} ${date(c.trialEnds)}` : "";
            return make("li", {}, make("div", {}, make("b", { textContent: c.name }), make("small", { textContent: `First signed in ${date(c.first)} · last used ${ago(c.last)}${trial}` })), out);
          })
        : [make("li", { className: "hint", textContent: "No computers signed in." })]),
    );
    $("d-danger").hidden = d.admin;
  }
  /** Runs an action on the open account, then refreshes the panel and the views. */
  const act = (body, done) =>
    busy($("d-msg"), async () => {
      const d = await api("POST", { email: current.email, ...body });
      if (d.deleted) dialog.close();
      else if (!d.sent) fill(d);
      $("d-msg").textContent = done;
      load();
    });

  $("d-close").onclick = () => dialog.close();
  $("issue").onsubmit = (e) => {
    e.preventDefault();
    const len = $("i-length").value;
    const send = $("i-send").checked;
    act({ action: "issue", plan: $("i-plan").value, [len[0] === "m" ? "months" : "days"]: Number(len.slice(1)), send }, send ? "Licence issued and emailed." : "Licence issued.");
  };
  $("d-revoke").onclick = () => confirm(`Revoke the licence for ${current.church}?`) && act({ action: "revoke" }, "Licence revoked.");
  $("d-rename").onsubmit = (e) => {
    e.preventDefault();
    act({ action: "rename", church: $("d-name").value }, "Renamed.");
  };
  $("d-reset").onclick = () => act({ action: "resetEmail" }, `A password-reset email is on its way to ${current.email}.`);
  $("d-signout").onclick = () => confirm(`Sign ${current.church} out of every computer and the website?`) && act({ action: "signOutAll" }, "Signed out everywhere.");
  $("d-delete").onsubmit = (e) => {
    e.preventDefault();
    act({ action: "delete", confirm: $("d-confirm").value }, "Account deleted.");
  };

  gate();
})();
