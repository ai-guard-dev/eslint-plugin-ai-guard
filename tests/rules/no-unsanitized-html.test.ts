import { describe, it, expect } from 'vitest';
import { ruleTester, tsRuleTester } from '../helpers/rule-tester';
import { noUnsanitizedHtml } from '../../src/rules/security/no-unsanitized-html';

const jsx = { languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } };

ruleTester.run('no-unsanitized-html', noUnsanitizedHtml, {
  valid: [
    // ── Static markup ──
    'el.innerHTML = "";',
    'el.innerHTML = "<p>Loading...</p>";',
    'el.innerHTML = `<div class="spinner"></div>`;',
    'el.innerHTML += "<br>";',
    'template.innerHTML = `<style>:host { display: block; }</style><slot></slot>`;',
    'const ROW = "<tr><td></td></tr>"; table.innerHTML = ROW;',
    'const markup = "<b>bold</b>"; el.innerHTML = markup;',
    'const icons = { ok: "<svg></svg>", fail: "<svg></svg>" }; el.innerHTML = icons.ok;',
    'import iconSvg from "./check.svg?raw"; el.innerHTML = iconSvg;',
    'import { ICONS } from "./icons"; el.innerHTML = ICONS.check;',
    'el.innerHTML = isOpen ? "<span>-</span>" : "<span>+</span>";',
    // ── Sanitized ──
    'el.innerHTML = DOMPurify.sanitize(userHtml);',
    'el.innerHTML = sanitizeHtml(comment.body);',
    'el.innerHTML = `<p>${escapeHtml(user.name)}</p>`;',
    'const clean = DOMPurify.sanitize(html); el.innerHTML = clean;',
    'el.innerHTML = sanitizedHtml;',
    'el.innerHTML = name.replace(/</g, "&lt;");',
    'el.innerHTML = text.replace(/[&<>"\']/g, (c) => map[c]);',
    // ── Values that cannot carry markup ──
    'counter.innerHTML = String(total * 2);',
    'el.innerHTML = `<span>${items.length}</span>`;',
    'el.innerHTML = `<td>${price.toFixed(2)}</td>`;',
    'el.innerHTML = `<time>${date.toLocaleDateString()}</time>`;',
    'el.innerHTML = Number(value);',
    // Copying markup that is already in the DOM
    'target.innerHTML = source.innerHTML;',
    // Translation strings are authored content
    'el.innerHTML = t("legal.terms");',
    // Local helpers and builders that only produce static markup
    'function spinner() { return "<div class=\\"spinner\\"></div>"; } el.innerHTML = spinner();',
    'let html = ""; for (let i = 0; i < 3; i++) { html += "<li></li>"; } list.innerHTML = html;',
    'const rows = ["<tr></tr>", "<tr></tr>"]; table.innerHTML = rows.join("");',
    // Not the DOM API
    'stream.write(chunk);',
    'el.insertAdjacentText("beforeend", userInput);',
    'el.textContent = userInput;',
    'doc.write(userInput);',
    // ── React ──
    { code: '<div dangerouslySetInnerHTML={{ __html: "<b>static</b>" }} />;', ...jsx },
    { code: '<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(post.html) }} />;', ...jsx },
    { code: 'function createMarkup() { return { __html: "First &middot; Second" }; }\n<div dangerouslySetInnerHTML={createMarkup()} />;', ...jsx },
    { code: 'const html = { __html: "<hr>" };\n<div dangerouslySetInnerHTML={html} />;', ...jsx },
    { code: '<div dangerouslySetInnerHTML={{ __html: t("home.hero") }} />;', ...jsx },
    'React.createElement("div", { dangerouslySetInnerHTML: { __html: "<i>x</i>" } });',
    // Escaping renderers (found in vercel/ai-chatbot and steven-tey/novel)
    { code: 'const html = renderToString(<Message>{content}</Message>); container.innerHTML = html;', ...jsx },
    'dom.innerHTML = katex.renderToString(latex, options);',
    { code: 'el.innerHTML = ReactDOMServer.renderToStaticMarkup(<Icon />);', ...jsx },
    // JSON-LD escaped the way the Next.js docs recommend
    { code: '<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\\\u003c") }} />;', ...jsx },
    // Test files build DOM fixtures from strings
    { code: 'document.body.innerHTML = fixtureHtml;', filename: 'src/widget.test.js' },
  ],
  invalid: [
    // ── The classic AI pattern: template literal interpolation ──
    {
      code: 'el.innerHTML = `<div class="card"><h2>${user.name}</h2></div>`;',
      errors: [{ messageId: 'unsanitizedHtml', data: { sink: 'innerHTML' } }],
    },
    {
      code: 'list.innerHTML = items.map((item) => `<li>${item.title}</li>`).join("");',
      errors: [{ messageId: 'unsanitizedHtml', data: { sink: 'innerHTML' } }],
    },
    {
      code: 'let html = "";\nfor (const c of comments) { html += "<p>" + c.text + "</p>"; }\nfeed.innerHTML = html;',
      errors: [{ messageId: 'unsanitizedHtml', line: 3 }],
    },
    {
      code: 'function render(html) { container.innerHTML = html; }',
      errors: [{ messageId: 'unsanitizedHtml', data: { sink: 'innerHTML' } }],
    },
    {
      code: 'function row(u) { return `<tr><td>${u.email}</td></tr>`; }\ntable.innerHTML = users.map(row).join("");',
      errors: [{ messageId: 'unsanitizedHtml' }],
    },
    {
      code: 'el.outerHTML = "<span>" + label + "</span>";',
      errors: [{ messageId: 'unsanitizedHtml', data: { sink: 'outerHTML' } }],
    },
    {
      code: 'chat.insertAdjacentHTML("beforeend", `<div class="msg">${message}</div>`);',
      errors: [{ messageId: 'unsanitizedHtml', data: { sink: 'insertAdjacentHTML' } }],
    },
    {
      code: 'document.write("<p>" + data + "</p>");',
      errors: [{ messageId: 'unsanitizedHtml', data: { sink: 'document.write' } }],
    },
    {
      code: 'el.innerHTML = await (await fetch("/api/banner")).text();',
      errors: [{ messageId: 'unsanitizedHtml' }],
    },
    // A sanitizer applied to only part of the value does not cover the rest
    {
      code: 'el.innerHTML = `<b>${escapeHtml(name)}</b> ${bio}`;',
      errors: [{ messageId: 'unsanitizedHtml' }],
    },

    // ── Attacker-controlled sources ──
    {
      code: 'results.innerHTML = `Results for ${new URLSearchParams(location.search).get("q")}`;',
      errors: [{ messageId: 'untrustedHtml', data: { sink: 'innerHTML', source: 'a URL query parameter' } }],
    },
    {
      code: 'el.innerHTML = decodeURIComponent(location.hash.slice(1));',
      errors: [{ messageId: 'unsanitizedHtml' }],
    },
    {
      code: 'el.innerHTML = window.location.hash;',
      errors: [{ messageId: 'untrustedHtml', data: { sink: 'innerHTML', source: 'the page URL' } }],
    },
    {
      code: 'const q = searchParams.get("q"); el.innerHTML = `<h1>${q}</h1>`;',
      errors: [{ messageId: 'untrustedHtml', data: { sink: 'innerHTML', source: 'a URL query parameter' } }],
    },
    {
      code: 'window.addEventListener("message", (event) => { frame.innerHTML = event.data; });',
      errors: [{ messageId: 'untrustedHtml', data: { sink: 'innerHTML', source: 'postMessage data' } }],
    },
    {
      code: 'el.innerHTML = localStorage.getItem("draft");',
      errors: [{ messageId: 'untrustedHtml', data: { sink: 'innerHTML', source: 'browser storage' } }],
    },
    {
      code: 'app.get("/", (req, res) => { document.write(req.query.name); });',
      errors: [{ messageId: 'untrustedHtml', data: { sink: 'document.write', source: 'request input' } }],
    },
    // ── LLM output rendered as HTML ──
    {
      code: 'const completion = await openai.chat.completions.create(opts);\nout.innerHTML = completion.choices[0].message.content;',
      errors: [{ messageId: 'untrustedHtml', data: { sink: 'innerHTML', source: 'an LLM response' } }],
    },
    {
      code: 'const msg = await anthropic.messages.create(opts);\nout.innerHTML = msg.content[0].text;',
      errors: [{ messageId: 'untrustedHtml', data: { sink: 'innerHTML', source: 'an LLM response' } }],
    },
    {
      code: 'const { text } = await generateText({ model, prompt });\nout.innerHTML = text;',
      errors: [{ messageId: 'untrustedHtml', data: { sink: 'innerHTML', source: 'an LLM response' } }],
    },
    // ── JSON in script tags (vercel/commerce product page pattern) ──
    {
      code: '<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }} />;',
      ...jsx,
      errors: [{ messageId: 'jsonHtml', data: { sink: 'dangerouslySetInnerHTML' } }],
    },
    {
      code: 'boot.innerHTML = `<script>window.__STATE__ = ${JSON.stringify(state)}</script>`;',
      errors: [{ messageId: 'jsonHtml', data: { sink: 'innerHTML' } }],
    },
    // ── Markdown renderers ──
    {
      code: 'preview.innerHTML = marked(post.body);',
      errors: [{ messageId: 'markdownHtml', data: { sink: 'innerHTML' } }],
    },
    {
      code: 'preview.innerHTML = md.render(source);',
      errors: [{ messageId: 'markdownHtml' }],
    },
    // ── React ──
    {
      code: 'const Post = ({ post }) => <article dangerouslySetInnerHTML={{ __html: post.content }} />;',
      ...jsx,
      errors: [{ messageId: 'unsanitizedHtml', data: { sink: 'dangerouslySetInnerHTML' } }],
    },
    {
      code: 'const Answer = ({ answer }) => <div dangerouslySetInnerHTML={{ __html: marked.parse(answer) }} />;',
      ...jsx,
      errors: [{ messageId: 'markdownHtml', data: { sink: 'dangerouslySetInnerHTML' } }],
    },
    {
      code: 'function createMarkup(html) { return { __html: html }; }\nconst C = ({ html }) => <div dangerouslySetInnerHTML={createMarkup(html)} />;',
      ...jsx,
      errors: [{ messageId: 'unsanitizedHtml' }],
    },
    {
      code: 'React.createElement("div", { dangerouslySetInnerHTML: { __html: props.html } });',
      errors: [{ messageId: 'unsanitizedHtml', data: { sink: 'dangerouslySetInnerHTML' } }],
    },
  ],
});

tsRuleTester.run('no-unsanitized-html (TypeScript)', noUnsanitizedHtml, {
  valid: [
    'const el = document.getElementById("x")!; el.innerHTML = DOMPurify.sanitize(html as string);',
    'const TEMPLATE = "<p></p>" as const; el.innerHTML = TEMPLATE;',
  ],
  invalid: [
    {
      code: 'function show(err: Error): void { banner.innerHTML = `<strong>${err.message}</strong>`; }',
      errors: [{ messageId: 'unsanitizedHtml' }],
    },
    {
      code: 'const Bio = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html! }} />;',
      filename: 'file.tsx',
      ...jsx,
      errors: [{ messageId: 'unsanitizedHtml', data: { sink: 'dangerouslySetInnerHTML' } }],
    },
  ],
});

describe('no-unsanitized-html messages', () => {
  it('tells users to write the two-backslash escape that Next.js documents', () => {
    const expected = `replace(/</g, '${String.fromCharCode(92).repeat(2)}u003c')`;
    expect(noUnsanitizedHtml.meta.messages.jsonHtml).toContain(expected);
  });
});
