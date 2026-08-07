# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x (latest) | ✅ Active support |
| < 1.0 | ❌ No longer supported |

We recommend always using the latest patch release.

---

## Reporting a Security Vulnerability

**Please do not report security vulnerabilities via public GitHub issues.**

To report a vulnerability responsibly:

1. **Email:** Open a [GitHub Security Advisory](https://github.com/ai-guard-dev/eslint-plugin-ai-guard/security/advisories/new)
   directly on the repository (private by default).

2. **Include in your report:**
   - A clear description of the vulnerability
   - Steps to reproduce (minimal code example if applicable)
   - The affected version(s)
   - Your assessment of severity and impact
   - Any suggested fix (optional but appreciated)

3. **Response time:** We aim to acknowledge reports within 48 hours and provide an
   initial assessment within 5 business days.

4. **Disclosure:** We follow a 90-day responsible disclosure policy. We will coordinate
   with you on timing before any public disclosure.

---

## Scope

### In scope

- Vulnerabilities in the ai-guard ESLint plugin rules (false negatives for security rules)
- Vulnerabilities in the CLI (arbitrary code execution, path traversal, etc.)
- Vulnerabilities in the SARIF generation that could cause security information to be
  suppressed or misrepresented in GitHub Code Scanning
- Supply chain issues (malicious dependencies)

### Out of scope

- Vulnerabilities in projects that use ai-guard (report to those projects directly)
- False positives (open a public issue — these are not security vulnerabilities)
- Missing rule coverage for new AI-generated patterns (open a public issue or PR)
- Vulnerabilities in GitHub Actions or GitHub Code Scanning infrastructure
  (report to GitHub Security: https://github.com/security)

---

## Workflow Security Notes

### GitHub Actions

The official ai-guard GitHub Actions workflow requires `security-events: write` to upload
SARIF to GitHub Code Scanning. This permission is scoped to the security events API only
and does not grant write access to repository contents.

We recommend pinning action versions to a specific commit SHA in production workflows
to prevent supply chain attacks:

```yaml
# Instead of:
- uses: github/codeql-action/upload-sarif@v3

# Pin to a specific SHA:
- uses: github/codeql-action/upload-sarif@v3
  # SHA: check github/codeql-action releases for current SHA
```

### AI-Generated Code Risks

ai-guard itself is designed to detect security issues in AI-generated code. However,
the tool cannot guarantee that it catches all AI-generated vulnerabilities. The rules
focus on the most consistently observed patterns from major AI coding assistants.

If you discover a new AI-generated security pattern that ai-guard misses, please
open a public issue with a code example — these are treated as feature requests, not
security vulnerabilities.

---

## Security-Relevant Rules

The following ai-guard rules are specifically designed to catch security vulnerabilities
in AI-generated code:

| Rule | Risk Caught |
|------|------------|
| `no-hardcoded-secret` | Credential exposure — API keys, tokens, passwords |
| `no-eval-dynamic` | Remote code execution via `eval()` or `new Function()` |
| `no-sql-string-concat` | SQL injection via string concatenation |
| `no-unsafe-deserialize` | Unsafe deserialization of untrusted input |
| `require-auth-middleware` | Missing authentication on API routes |
| `require-authz-check` | Missing authorization / ownership verification |

These rules have a `security-severity` field in SARIF output that GitHub uses to
classify findings in Code Scanning.
