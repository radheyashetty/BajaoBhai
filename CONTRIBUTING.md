# Contributing to Bajao Bhai

Thank you for your interest in contributing to **Bajao Bhai**! We welcome contributions, bug reports, feature requests, and pull requests.

## Code of Conduct

Please be respectful and constructive in all issues, pull requests, and discussions.

## How to Contribute

1. **Fork the Repository**: Create your own fork of the project on GitHub.
2. **Clone & Setup**:
   ```bash
   git clone https://github.com/radheyashetty/BajaoBhai.git
   cd BajaoBhai
   npm install
   cp .env.example .env
   ```
3. **Create a Feature Branch**:
   ```bash
   git checkout -b feature/amazing-new-feature
   ```
4. **Make Your Changes**:
   - Ensure code follows existing formatting rules (`npm run format`).
   - Run linter and verify syntax (`npm run lint`).
5. **Commit Your Changes**:
   ```bash
   git commit -m "feat: add amazing new feature"
   ```
6. **Push and Open a Pull Request**: Push your branch to GitHub and open a Pull Request against the `main` branch.

## Code Style & Standards

- Use ES6+ JavaScript standards.
- Run `npm run lint` before committing to ensure there are no linter errors.
- Run `npm run format` to auto-format files with Prettier.

## Security Disclosures

If you discover a security vulnerability, please refer to [SECURITY.md](SECURITY.md) for reporting guidelines.
