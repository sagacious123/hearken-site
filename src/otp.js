// Six boxes for a 6-digit code. It enhances each <input data-otp>: the original input stays,
// hidden, and still holds the whole code, so pages read and set `input.value` as before, and
// `input.focus()` goes to the first empty box. Typing moves on, Backspace moves back, pasting
// (or a phone filling in the code) fills every box. With data-otp="submit" the form sends
// itself once the last digit is in.
(() => {
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

  function enhance(input) {
    const n = input.maxLength > 0 && input.maxLength <= 10 ? input.maxLength : 6;
    const label = document.querySelector(`label[for="${input.id}"]`);
    const group = document.createElement("div");
    group.className = "otp";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label?.textContent.trim() || input.placeholder || "Code");
    const boxes = Array.from({ length: n }, (_, i) => {
      const b = document.createElement("input");
      Object.assign(b, { type: "text", inputMode: "numeric", autocomplete: i === 0 ? "one-time-code" : "off", maxLength: n });
      b.setAttribute("aria-label", `Digit ${i + 1} of ${n}`);
      if (i === 0) b.id = `${input.id}-1`;
      group.append(b);
      return b;
    });
    if (label) label.htmlFor = boxes[0].id;
    input.classList.add("otp-source");
    input.tabIndex = -1;
    input.after(group);

    const sync = () => native.set.call(input, boxes.map((b) => b.value).join(""));
    Object.defineProperty(input, "value", {
      get: () => native.get.call(input),
      set(v) {
        const digits = String(v ?? "").replace(/\D/g, "").slice(0, n);
        boxes.forEach((b, i) => (b.value = digits[i] ?? ""));
        native.set.call(input, digits);
      },
    });
    input.focus = () => (boxes.find((b) => !b.value) ?? boxes[n - 1]).focus();

    const complete = () => {
      if (input.value.length === n && input.dataset.otp === "submit" && input.form) input.form.requestSubmit();
    };
    /** Puts `digits` in the boxes from `from` on. */
    const fill = (from, digits) => {
      [...digits].forEach((d, k) => boxes[from + k] && (boxes[from + k].value = d));
      sync();
      boxes[Math.min(from + digits.length, n - 1)].focus();
      complete();
    };

    boxes.forEach((b, i) => {
      b.addEventListener("input", () => {
        const digits = b.value.replace(/\D/g, "");
        if (digits.length > 1) {
          b.value = "";
          return fill(i, digits.slice(0, n - i));
        }
        b.value = digits;
        sync();
        if (digits && i < n - 1) boxes[i + 1].focus();
        if (digits) complete();
      });
      b.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !b.value && i > 0) {
          e.preventDefault();
          boxes[i - 1].value = "";
          boxes[i - 1].focus();
          sync();
        } else if (e.key === "ArrowLeft" && i > 0) {
          e.preventDefault();
          boxes[i - 1].focus();
        } else if (e.key === "ArrowRight" && i < n - 1) {
          e.preventDefault();
          boxes[i + 1].focus();
        }
      });
      b.addEventListener("paste", (e) => {
        const digits = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "");
        if (!digits) return;
        e.preventDefault();
        fill(0, digits.slice(0, n));
      });
      b.addEventListener("focus", () => b.select());
    });

    // Pages show and hide the code field; the boxes follow.
    const follow = () => (group.hidden = input.hidden);
    new MutationObserver(follow).observe(input, { attributes: true, attributeFilter: ["hidden"] });
    follow();
  }

  document.querySelectorAll("input[data-otp]").forEach(enhance);
})();
