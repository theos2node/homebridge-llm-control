# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Added unit coverage for JSON extraction, runtime configuration, redaction,
  and Homebridge UI configuration normalization.
- Made model-response parsing brace- and quoted-string-aware.
- Prevented invalid model responses from being included in thrown errors.
- Added a multi-version Node.js release gate and Dependabot configuration.
- Updated the project page and maintainer documentation.

## v1.4.0

- Runtime skills system with propose/approve workflow
- LLM can propose a skill for explicit approval and run approved skills under
  cooldown and daily-quota limits

## v1.3.3

- Improved HAP bridge port discovery via `persist/AccessoryInfo.*.json` fallback

## v1.3.2

- Fix: support short HAP types (`"43"`, `"25"`, etc.) returned by some `/accessories` endpoints

## v1.3.1

- Deterministic natural-language shortcut for “turn off all lights …” (no LLM required)

## v1.3.0

- Added ntfy (two-way) + Discord webhook (notifications)

## v1.2.0

- Direct Homebridge accessory control via local HAP HTTP
- One-shot scheduling + operations restart
