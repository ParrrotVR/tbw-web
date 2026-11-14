export function browserPlugin(tab, actions) {
  return new (class extends $scramjetController.ManagedPlugin {
    constructor() { super('harbor-browser', []); }
    install(frame) {
      super.install(frame);
      this.tap(frame.hooks.init.pre, context => {
        const original = context.client.wrapfn;
        // Primitives cannot be Location, eval, parent or top. Preserve the
        // upstream handling for every object/function, including windows.
        context.client.wrapfn = function (value, strict) {
          if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
          return original(value, strict);
        };
      });
      this.tap(frame.hooks.init.post, context => {
        if (!context.isTopLevel || tab.closed) return;
        const client = context.client;
        const document = context.window.document;
        const notify = kind => {
          if (!tab.closed) actions.navigation(tab, client.url.href, kind);
        };
        notify('commit');
        this.tap(client.hooks.lifecycle.navigate, (event, props) => {
          if (!tab.closed) actions.navigation(tab, props.url, event.type);
        });
        let previousTitle;
        const updateTitle = () => {
          if (tab.closed || document.title === previousTitle) return;
          previousTitle = document.title; actions.title(tab, previousTitle);
        };
        updateTitle();
        if (document.head) {
          const observer = new MutationObserver(updateTitle);
          observer.observe(document.head, { subtree: true, childList: true, characterData: true });
          context.window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
          tab.observers.push(observer);
        }
        context.window.addEventListener('hashchange', () => notify('history'));
        const destination = value => {
          const decoded = client.unrewriteUrl(String(value));
          return new URL(decoded, client.url.href).href;
        };
        const click = event => {
          const anchor = event.target?.closest?.('a[href]');
          if (!anchor || anchor.hasAttribute('download') || !((anchor.target === '_blank') || event.ctrlKey || event.metaKey || event.button === 1)) return;
          try {
            const url = destination(anchor.href);
            if (!/^https?:/.test(url)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            actions.newTab(url, !(event.ctrlKey || event.metaKey || event.button === 1));
          } catch {}
        };
        document.addEventListener('click', click, true);
        document.addEventListener('auxclick', click, true);
        client.Proxy('window.open', {
          apply(ctx) {
            const target = ctx.args[1] ?? '_blank';
            if (['_self', '_parent', '_top'].includes(target)) return;
            try {
              const url = ctx.args[0] ? destination(ctx.args[0]) : null;
              if (url && !/^https?:/.test(url)) return ctx.return(null);
              const child = actions.newTab(url, true);
              if (!child.frame) actions.ensureFrame(child);
              return ctx.return(child.frame?.element.contentWindow ?? null);
            } catch { return ctx.return(null); }
          },
        });
        context.window.addEventListener('keydown', actions.keydown);
      });
    }
  })();
}
