window.__ModuleLoader__.load({
  id: "dsh-quick-menu",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** Caption label. */
    const LABEL = "\u5feb\u6377\u83dc\u5355";
    /** Marks every element this plugin owns. */
    const MARK = "data-dsh-quick-menu";
    /** Host routes. */
    const ROUTES = {
      webUrl: "dsh-quick-menu/web-url",
      diagnose: "dsh-quick-menu/diagnose",
      repair: "dsh-quick-menu/repair",
      restart: "dsh-quick-menu/restart",
      reload: "dsh-quick-menu/reload",
    };
    /** Colours used only if the shell declares no palette at all. */
    const FALLBACK = { surface: "#1e2021", text: "#e8eaeb", muted: "#9aa0a6", rule: "rgba(255,255,255,.12)", hover: "rgba(255,255,255,.08)" };

    /**
     * Ask the Host to reload this bundle in place, so an update lands without a
     * DSH restart. Same markers as the mutating routes, since it rewrites state.
     */
    const reloadBundle = async () => {
      const version = await freshVersion();
      const response = await fetch(new URL(ROUTES.reload, document.baseURI), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-dsh-quick-menu": "1",
        },
        credentials: "same-origin",
        body: JSON.stringify({ version }),
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(answer?.message ?? `HTTP ${String(response.status)}`);
      return answer;
    };

    /** Read the version the Host would reload, for the staleness handshake. */
    const freshVersion = async () => {
      try {
        const answer = await get(ROUTES.diagnose);
        return typeof answer?.installVersion === "string" ? answer.installVersion : "";
      } catch {
        return "";
      }
    };

    /** Shown while a newer copy is being published and the page reloads. */
    const staleMessage = "\u63d2\u4ef6\u6e90\u7801\u6709\u66f4\u65b0\uff0c\u6b63\u5728\u91cd\u65b0\u53d1\u5e03\u5e76\u5237\u65b0\u9875\u9762\u2026";

    /** The caption button, once mounted. */
    let button;
    /** The dropdown panel, once mounted. */
    let panel;
    /** The panel's status line. */
    let status;
    /** Tokens that held no value at document level, resolved once per theme. */
    const pendingTokens = new Set();

    /**
     * The shipped stylesheet never declares the tokens: the palette arrives as
     * inline declarations on one of the shell wrappers, so the walk has to look
     * far enough. Without a hit the panel would paint with CSS initial values, which is white text on a white surface.
     * @param name - token name without the `--` prefix.
     * @returns the declaration, or the empty string.
     */
    const declared = (name) => {
      const property = `--${name}`;
      /** One element's own computed declaration. */
      const own = (element) => getComputedStyle(element).getPropertyValue(property).trim();
      const root = document.documentElement;
      const direct = own(root);
      if (direct !== "") return direct;
      // Sweep the shell wrappers, then everything else, for the declarations.
      for (const element of document.querySelectorAll("[data-ds-dark-theme], [class], body > div")) {
        const value = own(element);
        if (value !== "") return value;
      }
      for (const element of document.body?.querySelectorAll("*") ?? []) {
        const style = element.getAttribute("style");
        if (style === null || !style.includes(property)) continue;
        const value = own(element);
        if (value !== "") return value;
      }
      return "";
    };

    /** Repaint the panel from the palette the document currently reports. */
    const repaint = () => {
      if (panel === undefined) return;
      const dark = document.querySelector("[data-ds-dark-theme]") !== null;
      /** One token, or a shipped colour when the shell declares none. */
      const pick = (name, fallbacks) => {
        const value = declared(name);
        if (value === "") {
          pendingTokens.add(name);
          return dark ? fallbacks[1] : fallbacks[0];
        }
        pendingTokens.delete(name);
        return value;
      };
      panel.style.setProperty("background", pick("dsw-alias-bg-layer-2", [FALLBACK.surface, FALLBACK.surface]));
      panel.style.setProperty("color", pick("dsw-alias-label-primary", [FALLBACK.text, FALLBACK.text]));
      panel.style.setProperty("border-color", pick("dsw-alias-border-l2", [FALLBACK.rule, FALLBACK.rule]));
      panel.querySelectorAll(`[${MARK}=item]`).forEach((item) => {
        item.style.setProperty("--hover", pick("dsw-alias-interactive-bg-hover", [FALLBACK.hover, FALLBACK.hover]));
      });
      panel.querySelectorAll(`[${MARK}=status]`).forEach((line) => {
        line.style.setProperty("--muted", pick("dsw-alias-label-secondary", [FALLBACK.muted, FALLBACK.muted]));
        line.style.setProperty("--error", pick("dsw-alias-state-error-primary", ["#d1242f", "#ff8b8b"]));
        line.style.setProperty("--warn", pick("dsw-alias-state-warn-primary", ["#9a6700", "#e3b341"]));
      });
      panel.querySelectorAll(`[${MARK}=sep]`).forEach((rule) => {
        rule.style.setProperty("--rule", pick("dsw-alias-border-l2", [FALLBACK.rule, FALLBACK.rule]));
      });
    };

    /** Post to a mutating route with the markers the Host insists on. */
    const post = async (route) => {
      const response = await fetch(new URL(route, document.baseURI), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-dsh-quick-menu": "1",
        },
        credentials: "same-origin",
        body: "{}",
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(answer?.message ?? `HTTP ${String(response.status)}`);
      return answer;
    };

    /** Read a diagnostic route. */
    const get = async (route) => {
      const response = await fetch(new URL(route, document.baseURI), {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      const answer = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(answer?.message ?? `HTTP ${String(response.status)}`);
      return answer;
    };

    /** Show one line of feedback inside the panel, colouring failures. */
    const say = (text, tone) => {
      if (status === undefined) return;
      status.textContent = text;
      status.dataset.tone = tone ?? "";
    };

    /** Open the Web GUI in the OS browser. */
    const openWebGui = async () => {
      say("\u6b63\u5728\u53d6\u53d7\u4fe1\u5730\u5740\u2026");
      try {
        const answer = await get(ROUTES.webUrl);
        if (typeof answer?.url !== "string" || answer.url === "") throw new Error("the Host returned no URL");
        window.open(answer.url, "_blank");
        say("");
      } catch (error) {
        say(`\u6253\u5f00\u5931\u8d25\uff1a${error.message}`, "error");
      }
    };

    /** Report what pins the plugin manager, without touching anything. */
    const checkState = async () => {
      try {
        const report = await get(ROUTES.diagnose);
        const parts = [];
        if (report.run?.present) {
          parts.push(report.run.alive ? `run.json pid ${String(report.run.pid)} \u4ecd\u5728` : `run.json \u6b8b\u7559 pid ${String(report.run.pid)}`);
        }
        const pending = report.pending?.operations ?? [];
        if (pending.length > 0) parts.push(`${String(pending.length)} \u6761\u672a\u5b8c\u6210\u66f4\u65b0`);
        if ((report.strays ?? []).length > 0) parts.push(`${String(report.strays.length)} \u4e2a\u6b8b\u7559\u9501\u6587\u4ef6`);
        say(parts.length === 0 ? "\u72b6\u6001\uff1a\u65e0\u963b\u585e" : `\u72b6\u6001\uff1a${parts.join("\uff0c")}`, parts.length === 0 ? "" : "warn");
      } catch (error) {
        say(`\u8bca\u65ad\u5931\u8d25\uff1a${error.message}`, "error");
      }
    };

    /** Clear the lock state and report what was removed. */
    const repairLock = async () => {
      say("\u6b63\u5728\u4fee\u590d\u2026");
      try {
        const answer = await post(ROUTES.repair);
        const removed = answer?.removed ?? [];
        const stale = answer?.staleInstall === true;
        if (removed.length === 0) {
          if (!stale) say("\u6ca1\u6709\u9700\u8981\u6e05\u7406\u7684\u9501\u3002");
        } else {
          say(`\u5df2\u6e05\u7406 ${String(removed.length)} \u9879\u9501\u8bb0\u5f55\u3002`);
        }
        if (stale) {
          // A newer copy waits on disk: publish it and reload this page so the
          // running code matches the file instead of asking for a DSH restart.
          say(staleMessage);
          await reloadBundle();
          setTimeout(() => window.location.reload(), 400);
        }
      } catch (error) {
        say(`\u4fee\u590d\u5931\u8d25\uff1a${error.message}`, "error");
      }
    };

    /** Relaunch DSH; the page will drop while the replacement boots. */
    const restartDeepSeek = async () => {
      say("\u6b63\u5728\u91cd\u542f DeepSeek\u2026");
      try {
        await post(ROUTES.restart);
        say("\u5df2\u53d1\u9001\u91cd\u542f\u6307\u4ee4\uff0c\u7a97\u53e3\u5c06\u5728\u51e0\u79d2\u540e\u91cd\u5f00\u3002");
      } catch (error) {
        say(`\u91cd\u542f\u5931\u8d25\uff1a${error.message}`, "error");
      }
    };

    /** Build one action row. */
    const row = (label, run) => {
      const element = document.createElement("button");
      element.type = "button";
      element.setAttribute("role", "menuitem");
      element.setAttribute(MARK, "item");
      element.textContent = label;
      element.addEventListener("click", () => {
        void run();
      });
      element.addEventListener("mouseenter", () => {
        if (label.startsWith("\u4fee\u590d")) void checkState();
      });
      return element;
    };

    /** Place the panel under its button, clamped into the viewport. */
    const place = () => {
      if (button === undefined || panel === undefined) return;
      const anchor = button.getBoundingClientRect();
      panel.style.left = `${String(Math.max(4, Math.round(anchor.left)))}px`;
      panel.style.top = `${String(Math.round(anchor.bottom + 4))}px`;
      const box = panel.getBoundingClientRect();
      if (box.right > window.innerWidth - 4) {
        panel.style.left = `${String(Math.max(4, Math.round(window.innerWidth - box.width - 4)))}px`;
      }
    };

    /** Close the dropdown. */
    const close = () => {
      if (panel === undefined) return;
      panel.hidden = true;
      button?.setAttribute("aria-expanded", "false");
    };

    /** Open the dropdown and start describing the current lock state. */
    const open = () => {
      if (panel === undefined) return;
      repaint();
      panel.hidden = false;
      button?.setAttribute("aria-expanded", "true");
      place();
      void checkState();
    };

    /**
     * The palette is re-declared when the user switches themes and possibly once
     * more after the stylesheet lands, so repaint on both and resolve anything
     * that had no value at mount time.
     * @returns a disposer that stops watching.
     */
    const watchPalette = () => {
      const refresh = () => {
        for (const name of [...pendingTokens]) {
          if (getComputedStyle(document.documentElement).getPropertyValue(name).trim() !== "") pendingTokens.delete(name);
        }
        repaint();
      };
      const observer = new MutationObserver(refresh);
      for (const element of [document.documentElement, document.body]) {
        observer.observe(element, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class", "style"] });
      }
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
      refresh();
      return () => {
        observer.disconnect();
      };
    };

    /**
     * Mount the dropdown before the Desktop-owned menus.
     * @returns whether it is mounted.
     */
    const mount = () => {
      const host = document.querySelector("[data-windows-menu]");
      const bar = host?.shadowRoot?.querySelector("[role=menubar]");
      if (!bar) return false;
      const existing = bar.querySelector(`[${MARK}=button]`);
      if (existing !== null) {
        button = existing;
        panel = document.querySelector(`[${MARK}=panel]`) ?? undefined;
        return true;
      }

      const element = document.createElement("button");
      element.type = "button";
      element.setAttribute("role", "menuitem");
      element.setAttribute("aria-haspopup", "menu");
      element.setAttribute("aria-expanded", "false");
      element.setAttribute(MARK, "button");
      element.textContent = `${LABEL} \u25be`;
      element.title = LABEL;
      for (const type of ["pointerdown", "mousedown"]) {
        element.addEventListener(type, (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
      }
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        if (panel !== undefined && panel.hidden === false) close();
        else open();
      });

      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      menu.setAttribute(MARK, "panel");
      menu.hidden = true;
      menu.style.cssText = [
        "position:fixed",
        "min-width:220px",
        "padding:4px",
        "border-radius:8px",
        "border:1px solid transparent",
        "box-shadow:0 8px 24px rgba(0,0,0,.28)",
        "font-family:var(--dsw-font-family,system-ui)",
        "font-size:13px",
        "z-index:2147483000",
        "-webkit-app-region:no-drag",
      ].join(";");

      const style = document.createElement("style");
      style.textContent = `
        [${MARK}=item] { display:block; width:100%; text-align:left; height:30px; padding:0 10px;
          border:0; border-radius:6px; background:transparent; color:inherit; font:inherit; cursor:default; }
        [${MARK}=item]:hover { background:var(--hover, ${FALLBACK.hover}); }
        [${MARK}=status] { margin:4px 10px 2px; color:var(--muted, ${FALLBACK.muted}); font-size:12px; line-height:1.5; white-space:normal; }
        [${MARK}=status][data-tone=error] { color:var(--error, #ff8b8b); }
        [${MARK}=status][data-tone=warn] { color:var(--warn, #e3b341); }
        [${MARK}=sep] { height:1px; margin:4px 6px; background:var(--rule, ${FALLBACK.rule}); }
      `;

      const line = document.createElement("div");
      line.setAttribute(MARK, "status");
      line.textContent = "\u70b9\u5f00\u4efb\u4e00\u9879\u4ee5\u67e5\u770b\u72b6\u6001\u3002";

      const separator = document.createElement("div");
      separator.setAttribute(MARK, "sep");
      menu.append(row("\u4fee\u590d", repairLock), row("\u6253\u5f00\u7f51\u9875GUI", openWebGui), row("\u91cd\u542f DeepSeek", restartDeepSeek), separator, line);
      menu.prepend(style);

      // Insert BEFORE the first Desktop menu, so the dropdown sits where `\u5e94\u7528` used to.
      bar.insertBefore(element, bar.firstChild);
      document.body.append(menu);
      button = element;
      panel = menu;
      status = line;

      repaint();
      cellCloser();
      return true;
    };

    /** Outside clicks, Escape, resize, and scroll close the panel. */
    const cellCloser = () => {
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (panel === undefined || panel.hidden) return;
          if (event.composedPath().includes(panel)) return;
          if (event.composedPath().includes(button)) return;
          close();
        },
        true,
      );
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") close();
      });
      window.addEventListener("resize", close);
      window.addEventListener("scroll", close, true);
    };

    /**
     * Watch the document until the Desktop caption exists, then mount once.
     * @returns a disposer that removes the dropdown and stops watching.
     */
    const install = () => {
      if (mount()) {
        const stopWatching = watchPalette();
        return () => {
          stopWatching();
          button?.remove();
          panel?.remove();
          button = undefined;
          panel = undefined;
          status = undefined;
        };
      }
      const observer = new MutationObserver(() => {
        if (!mount()) return;
        observer.disconnect();
        stopWatching = watchPalette();
      });
      let stopWatching = () => {};
      observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        stopWatching();
        button?.remove();
        panel?.remove();
        button = undefined;
        panel = undefined;
        status = undefined;
      };
    };

    /**
     * Client plugin body: add the caption dropdown.
     * @param ctx - client plugin context; `effect` scopes the disposer when present.
     */
    function apply(ctx) {
      const dispose = install();
      if (typeof ctx?.effect === "function") ctx.effect(() => dispose, "dsh-quick-menu: caption dropdown");
    }

    /** No client service is required: the plugin reads the DOM and three Host routes. */
    const inject = [];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
