# no-unsanitized-html

**Category:** Security | **Severity:** `warn` (recommended), `error` (strict, security) | **Confidence:** medium

---

## What it does

Flags dynamic values written to HTML sinks without sanitizing:

- `el.innerHTML = …`, `el.innerHTML += …`, `el.outerHTML = …`
- `el.insertAdjacentHTML(position, …)`
- `document.write(…)`, `document.writeln(…)`
- React `dangerouslySetInnerHTML={{ __html: … }}`, including `React.createElement` props and `createMarkup()` helpers

It reports one of four messages:

| Message | When |
|---|---|
| **Untrusted source** | The value comes from the page URL (`location.*`, `URLSearchParams.get`), request input (`req.query/body/params`), `postMessage` data, browser storage, `prompt()`, or **an LLM response** (`choices[0].message.content`, `content[0].text`, Vercel AI SDK `generateText`) |
| **Markdown output** | The value comes from `marked()`, `marked.parse()`, `md.render()`, `converter.makeHtml()`, and similar renderers |
| **JSON in HTML** | The value is `JSON.stringify()` output, e.g. JSON-LD in a `<script>` tag. `JSON.stringify` does not escape `<`, so `</script>` in the data closes the tag. Fix: `JSON.stringify(data).replace(/</g, '\\u003c')`, as the Next.js docs recommend |
| **Unsanitized** | Any other dynamic value the rule cannot prove safe |

## Why it matters

XSS is the vulnerability class AI models handle worst: in Veracode's 2025 study, models failed to secure code against XSS (CWE-80) in **86%** of cases ([Veracode](https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/)). The typical generated code is a template literal with `${user.name}` written straight into `innerHTML`.

LLM output is a newer source of the same bug. A chat UI that renders the model's markdown with `marked` and `dangerouslySetInnerHTML` runs any `<img onerror>` a prompt injection gets the model to emit (OWASP LLM05, Improper Output Handling).

## ❌ Bad

```ts
card.innerHTML = `<h2>${user.name}</h2>`;
list.innerHTML = items.map((item) => `<li>${item.title}</li>`).join('');
results.innerHTML = `Results for ${new URLSearchParams(location.search).get('q')}`;
out.innerHTML = completion.choices[0].message.content;
<div dangerouslySetInnerHTML={{ __html: marked.parse(answer) }} />
```

## ✅ Good

```ts
card.textContent = user.name;                                  // no HTML parsing at all
card.innerHTML = DOMPurify.sanitize(`<h2>${user.name}</h2>`);
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(answer)) }} />
<p>{answer}</p>                                               // JSX text is escaped by React
```

## What it does not flag

`react/no-danger` flags every use, so teams turn it off. This rule follows values so it can stay on:

| Allowed | Example |
|---|---|
| Literals and templates with no dynamic parts | `el.innerHTML = '<div class="spinner"></div>'` |
| Sanitizers and escapers | `DOMPurify.sanitize(x)`, `sanitizeHtml(x)`, `xss(x)`, `escapeHtml(x)`, `he.encode(x)`, any `.replace(/</g, ...)` whose replacement has no `<` |
| Variables named as already safe | `sanitizedHtml`, `safeHtml`, `cleanMarkup` |
| Local constants and builders that only hold static markup | `const ROW = '<tr></tr>'`, `let html = ''; html += '<li></li>'`, `const ICONS = { ok: '<svg/>' }` |
| Imported values | `import iconSvg from './check.svg?raw'` (bundled code, not runtime input) |
| Values that cannot carry markup | `items.length`, `price.toFixed(2)`, `date.toLocaleDateString()`, `Number(x)`, arithmetic |
| Translation helpers | `t('legal.terms')`, `intl.formatMessage(...)` |
| Escaping renderers | `renderToString(<Message />)`, `renderToStaticMarkup()`, `katex.renderToString()` |
| Copying parsed DOM | `target.innerHTML = source.innerHTML` |
| Local helpers that return static markup | `function spinner() { return '<div class="spinner"></div>' }` |
| Test files | DOM fixtures are built from strings |

Values the rule cannot follow (function parameters, props, API results) are reported. That is intentional: those are where XSS comes from.

## How to fix

1. Prefer text: `textContent`, `innerText`, or JSX text, so the browser never parses the value as HTML.
2. If you need HTML, sanitize the **final** string with [DOMPurify](https://github.com/cure53/DOMPurify): `el.innerHTML = DOMPurify.sanitize(html)`.
3. For markdown, sanitize the renderer's output: `DOMPurify.sanitize(marked.parse(md))`.

## Configuration

This rule has no options.

```js
rules: {
  'ai-guard/no-unsanitized-html': 'warn',
}
```
