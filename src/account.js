// The account page: signs in to /api/account (an HttpOnly cookie), then shows the church's
// licence, computers, name and password. Everything people typed is shown as text, never HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  function build(tag, props, kids) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids.filter((k) => k != null));
    return node;
  }
  const date = (unix) => new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const lastUsed = (unix) => {
    const days = Math.floor((Date.now() / 1000 - unix) / 86400);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days} days ago` : `on ${date(unix)}`;
  };

  async function api(method, body) {
    const res = await fetch("/api/account", {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? "That didn’t work. Try again."), { status: res.status });
    return data;
  }
  /** Runs a form's request, saying what's happening in its message line. */
  async function busy(msg, fn) {
    msg.textContent = "One moment…";
    try {
      await fn();
    } catch (e) {
      msg.textContent = e instanceof TypeError ? "Couldn’t reach the server. Check your connection and try again." : e.message;
      if (e.status === 401 && !$("in").hidden) show(null);
    }
  }

  // ---- signed out ----
  let creating = false;
  function mode(create) {
    creating = create;
    $("tab-in").setAttribute("aria-selected", !create);
    $("tab-new").setAttribute("aria-selected", create);
    $("church-field").hidden = !create;
    $("church").required = create;
    $("pw-hint").hidden = !create;
    $("password").autocomplete = create ? "new-password" : "current-password";
    $("auth-go").textContent = create ? "Create account" : "Sign in";
    $("to-forgot").hidden = create;
    $("auth-msg").textContent = "";
  }
  $("tab-in").onclick = () => mode(false);
  $("tab-new").onclick = () => mode(true);
  $("to-forgot").onclick = () => { $("auth").hidden = true; $("forgot").hidden = false; $("forgot-email").value = $("email").value; $("forgot-email").focus(); };
  $("from-forgot").onclick = () => { $("forgot").hidden = true; $("auth").hidden = false; };

  /** A sign-up waiting for its emailed code. */
  let pending = null;
  const askCode = (email) => {
    $("auth").hidden = true;
    $("verify").hidden = false;
    $("verify-email").textContent = email;
    $("verify-code").value = "";
    $("verify-code").focus();
  };
  $("auth").onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    busy($("auth-msg"), async () => {
      const body = { email: f.email.value, password: f.password.value };
      if (creating) {
        pending = { action: "signup", church: f.church.value, ...body };
        const r = await api("POST", pending);
        $("auth-msg").textContent = "";
        askCode(r.email);
      } else {
        show(await api("POST", { action: "login", ...body }));
        f.reset();
      }
    });
  };
  $("verify").onsubmit = (e) => {
    e.preventDefault();
    busy($("verify-msg"), async () => {
      show(await api("POST", { action: "verifySignup", email: $("verify-email").textContent, code: $("verify-code").value }));
      $("auth").reset();
      $("verify").hidden = true;
      $("auth").hidden = false;
      pending = null;
    });
  };
  $("verify-again").onclick = () => busy($("verify-msg"), async () => { await api("POST", pending); $("verify-msg").textContent = "A new code is on its way."; });
  $("verify-back").onclick = () => { $("verify").hidden = true; $("auth").hidden = false; };
  $("forgot").onsubmit = (e) => {
    e.preventDefault();
    busy($("forgot-msg"), async () => {
      const res = await fetch("/api/auth/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("forgot-email").value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "That didn’t work. Try again.");
      $("forgot-msg").textContent = "If there’s an account for that email, a link to choose a new password is on its way. Check your spam folder too.";
    });
  };

  // ---- signed in ----
  function licence(a) {
    const box = $("licence");
    if (a.licence) {
      const ended = a.licence.expires * 1000 < Date.now();
      const copy = build("button", { type: "button", className: "btn ghost", textContent: "Copy licence key" }, []);
      copy.onclick = async () => { await navigator.clipboard.writeText(a.licence.key); copy.textContent = "Copied"; };
      box.replaceChildren(
        build("h2", { textContent: ended ? "Licence ended" : "Licence" }, []),
        build("p", { textContent: `${a.licence.church}: ${a.licence.plan} plan, ${ended ? "ended" : "until"} ${date(a.licence.expires)}.` }, []),
        build("p", { className: "hint", textContent: "Every computer signed in to this account uses it automatically." }, []),
        copy,
      );
    } else {
      box.replaceChildren(
        build("h2", { textContent: "Free trial" }, []),
        build("p", { textContent: "Each computer gets 60 days with every feature, from the day Hearken first opens on it." }, []),
        build("p", { className: "hint", textContent: "Paid plans will be announced before your trial ends." }, []),
      );
    }
  }

  function computers(a) {
    $("count").textContent = `${a.computers.length} of ${a.limit}`;
    const list = $("computers");
    if (!a.computers.length) {
      list.replaceChildren(build("li", { className: "empty" }, [
        build("span", { textContent: "No computers yet. Install Hearken Studio and sign in with this account." }, []),
        build("a", { className: "btn", href: "/#download", textContent: "Download" }, []),
      ]));
    } else {
      list.replaceChildren(...a.computers.map((c) => {
        const out = build("button", { type: "button", className: "btn ghost small", textContent: "Sign out" }, []);
        out.onclick = () => {
          if (!confirm(`Sign “${c.name}” out? Listening on it stops working until someone signs in there again. A service already listening isn’t interrupted.`)) return;
          busy($("computers-note"), async () => { render(await api("POST", { action: "remove", id: c.id })); $("computers-note").textContent = `“${c.name}” is signed out.`; });
        };
        const trial = !a.licence && c.trialEnds ? (c.trialEnds * 1000 > Date.now() ? ` · trial until ${date(c.trialEnds)}` : " · trial ended") : "";
        return build("li", {}, [build("div", {}, [build("b", { textContent: c.name }, []), build("small", { textContent: `Last used ${lastUsed(c.last)}${trial}` }, [])]), out]);
      }));
    }
    $("computers-note").textContent = a.computers.length >= a.limit
      ? `This account is on its ${a.limit} computers. To use another, sign one out here, or from the sign-in screen on the new computer.`
      : `Up to ${a.limit} computers can be signed in at once.`;
  }

  function render(a) {
    $("confirm").hidden = a.verified;
    $("confirm-email").textContent = a.email;
    $("church-name").textContent = a.church;
    $("who").textContent = `${a.email} · account since ${date(a.created)}`;
    $("new-church").value = a.church;
    licence(a);
    computers(a);
  }

  function show(a) {
    $("loading").hidden = true;
    document.documentElement.classList.toggle("signed-in", !!a);
    $("in").hidden = !a;
    $("out").hidden = !!a;
    if (a) render(a);
    else openFromAddress();
  }

  /** /account#create opens the sign-up form, /account#forgot the reset form (footer links). */
  function openFromAddress() {
    if ($("out").hidden) return;
    $("forgot").hidden = true;
    $("verify").hidden = true;
    $("auth").hidden = false;
    mode(location.hash === "#create");
    if (location.hash === "#forgot") $("to-forgot").click();
  }
  addEventListener("hashchange", openFromAddress);

  $("confirm-send").onclick = () =>
    busy($("confirm-msg"), async () => {
      await api("POST", { action: "sendConfirm" });
      $("confirm-code").hidden = false;
      $("confirm-go").hidden = false;
      $("confirm-send").textContent = "Send another code";
      $("confirm-send").className = "btn ghost";
      $("confirm-code").focus();
      $("confirm-msg").textContent = "Sent. Check your inbox and spam folder.";
    });
  $("confirm-form").onsubmit = (e) => {
    e.preventDefault();
    busy($("confirm-msg"), async () => { render(await api("POST", { action: "confirmEmail", code: $("confirm-code").value })); $("confirm-msg").textContent = ""; });
  };
  $("rename").onsubmit = (e) => {
    e.preventDefault();
    busy($("rename-msg"), async () => { render(await api("POST", { action: "church", church: $("new-church").value })); $("rename-msg").textContent = "Saved. The app shows the new name the next time it’s online."; });
  };
  $("password-form").onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    busy($("password-msg"), async () => { await api("POST", { action: "password", current: f.current.value, password: f.next.value }); f.reset(); $("password-msg").textContent = "Password changed."; });
  };
  $("sign-out").onclick = async () => { await api("POST", { action: "logout" }).catch(() => {}); show(null); };

  api("GET").then(show, () => show(null));
})();
