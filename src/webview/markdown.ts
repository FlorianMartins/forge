// Markdown → DOM. Not markdown → HTML: the difference is the whole security posture of the panel.
//
// It covers what a coding assistant actually emits — fenced code, inline code, bold, italic,
// headings, lists, numbered lists, blockquotes and links — and renders everything else as literal
// text. A link is rendered as text plus its target, never as a clickable remote URL: the panel has
// `default-src 'none'`, and a link that cannot be followed is better than one that exfiltrates.

import { button, el, ICON } from "./dom.js";
import { t } from "../shared/i18n.js";

export interface CodeActions {
  onCopy(code: string): void;
  onInsert(code: string): void;
  onApply(code: string, language: string): void;
}

export function markdown(text: string, actions?: CodeActions, highlight?: string): HTMLElement {
  const body = el("div", "md");
  const lines = text.split("\n");
  let i = 0;
  let paragraph: string[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    body.append(inline(paragraph.join("\n"), "p", highlight));
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    const fence = line.match(/^\s*```([a-zA-Z0-9+#._-]*)\s*$/);
    if (fence) {
      flush();
      const lang = fence[1] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      body.append(codeBlock(code.join("\n"), lang, actions));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(4, heading[1]!.length + 2);
      const node = inline(heading[2]!, `h${level}` as "h4", highlight);
      node.classList.add("md-h");
      body.append(node);
      i++;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flush();
      const block = el("blockquote", "md-quote");
      while (i < lines.length) {
        const q = lines[i]!.match(/^>\s?(.*)$/);
        if (!q) break;
        block.append(inline(q[1]!, "p", highlight));
        i++;
      }
      body.append(block);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flush();
      const list = el(numbered ? "ol" : "ul", "md-list");
      while (i < lines.length) {
        const b = lines[i]!.match(/^\s*[-*+]\s+(.*)$/);
        const n = lines[i]!.match(/^\s*\d+[.)]\s+(.*)$/);
        if (!b && !n) break;
        list.append(inline((b?.[1] ?? n?.[1])!, "li", highlight));
        i++;
      }
      body.append(list);
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flush();
  return body;
}

/** Inline spans: `code`, **bold**, *italic*, [texte](cible). Everything else stays literal. */
export function inline<K extends keyof HTMLElementTagNameMap>(
  text: string,
  tag: K,
  highlight?: string,
): HTMLElementTagNameMap[K] {
  const node = el(tag);
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) appendText(node, text.slice(last, m.index), highlight);
    const token = m[0];
    if (token.startsWith("`")) node.append(el("code", "md-code", token.slice(1, -1)));
    else if (token.startsWith("**") || token.startsWith("__")) node.append(el("strong", undefined, token.slice(2, -2)));
    else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]"));
      const target = token.slice(token.indexOf("](") + 2, -1);
      const link = el("span", "md-link", label);
      // Shown, not followed: the panel forbids remote origins, and a live link would be a way out.
      link.title = target;
      node.append(link);
    } else node.append(el("em", undefined, token.slice(1, -1)));
    last = m.index + token.length;
  }
  if (last < text.length) appendText(node, text.slice(last), highlight);
  return node;
}

/** Text, with the search term wrapped in a <mark> when there is one. */
function appendText(node: HTMLElement, text: string, highlight?: string): void {
  if (!highlight) {
    node.append(document.createTextNode(text));
    return;
  }
  const needle = highlight.toLocaleLowerCase("fr");
  const hay = text.toLocaleLowerCase("fr");
  let from = 0;
  let at = hay.indexOf(needle);
  while (at >= 0) {
    if (at > from) node.append(document.createTextNode(text.slice(from, at)));
    node.append(el("mark", "hit", text.slice(at, at + highlight.length)));
    from = at + highlight.length;
    at = hay.indexOf(needle, from);
  }
  if (from < text.length) node.append(document.createTextNode(text.slice(from)));
}

export function codeBlock(code: string, lang: string, actions?: CodeActions): HTMLElement {
  const wrap = el("div", "code-block");
  const head = el("div", "code-head");
  head.append(el("span", "code-lang", lang || t("text")));

  if (actions) {
    const tools = el("div", "code-tools");
    tools.append(
      button({ icon: ICON.copy, title: t("Copy this block"), className: "btn icon-only", onClick: () => actions.onCopy(code) }),
      button({ label: t("Insert"), title: t("Replace the selection in the editor"), className: "btn tiny", onClick: () => actions.onInsert(code) }),
      button({ label: t("Compare"), title: t("Open as a diff against the active file"), className: "btn tiny", onClick: () => actions.onApply(code, lang) }),
    );
    head.append(tools);
  }

  const pre = el("pre", "code");
  pre.append(el("code", undefined, code));
  wrap.append(head, pre);
  return wrap;
}
