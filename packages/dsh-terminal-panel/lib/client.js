window.__ModuleLoader__.load({
  id: "dsh-terminal-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = react.createElement;

    const inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs"];

    /** Placeholder body: proves the tab body slot is wired. */
    function PanelBody(props) {
      const { useTabInfo, t } = props;
      const tabInfo = useTabInfo();
      const [value, setValue] = react.useState("...");
      react.useEffect(() => {
        let alive = true;
        fetch("/dsh-terminal-panel/ping", { credentials: "same-origin" })
          .then((r) => r.json())
          .then((data) => { if (alive) setValue(JSON.stringify(data)); })
          .catch((error) => { if (alive) setValue("error: " + String(error)); });
        return () => { alive = false; };
      }, []);
      return h("div", {
        style: { padding: "16px", fontFamily: "monospace", fontSize: "12px", color: "var(--dsw-alias-label-primary)" },
        "data-dsh-terminal-panel": "body",
      }, [
        h("div", { key: "title" }, "dsh-terminal-panel skeleton"),
        h("div", { key: "tab" }, "tab: " + (tabInfo?.tab?.id ?? "?")),
        h("div", { key: "ping" }, "ping: " + value),
        h("div", { key: "copy" }, t("description")),
      ]);
    }

    function apply(ctx) {
      console.log("[dsh-terminal-panel] client half loaded");
      globalThis.__DSH_TERMINAL_PANEL__ = true;
      const namespace = "dshTerminalPanel";
      const id = "dsh-terminal-panel";
      const t = ctx.locale.bind(namespace);

      ctx.effect(() => ctx.locale.register(namespace, {
        zh: {
          title: "终端面板",
          description: "在侧栏显示一个可见的终端窗口",
          guideDescription: "打开可见终端面板",
        },
        en: {
          title: "Terminal Panel",
          description: "A visible terminal window in the sidebar",
          guideDescription: "Open the visible terminal panel",
        },
      }), "dsh-terminal-panel: locale");

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id,
        kind: "terminal-panel",
        multiple: true,
        priority: "extension",
        title: () => t("title"),
        guide: [{
          id: "open",
          order: 30,
          title: () => t("title"),
          description: () => t("guideDescription"),
          icon: primitives.PluginArtworkTerminal,
        }],
      }), "dsh-terminal-panel: tab type");

      ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab",
        key: id,
        locale: namespace,
        inject: () => ({}),
      }, PanelBody)), "dsh-terminal-panel: body");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
