# Security Policy

## Reporting Security Issues

The Bajao Bhai team takes security seriously. If you discover a vulnerability or security issue, please **do not** open a public issue.

Instead, please report security vulnerabilities responsibly by sending details to the repository maintainer.

### When Reporting a Security Issue

Please include the following details in your report:
- Type of issue (e.g., XSS, remote code execution, authentication bypass)
- Step-by-step instructions to reproduce the issue
- Potential impact of the vulnerability
- Any proposed remediation or patch

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Security Best Practices

- **Never commit `.env` or API keys** to version control.
- Always use strong, randomly generated secrets for `TOKEN_SECRET` and `ADMIN_SECRET` in production environments.
- Keep dependencies updated using `npm audit`.
