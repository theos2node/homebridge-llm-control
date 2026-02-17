# Changelog

All notable changes to this project will be documented in this file.

## v1.4.0

- Runtime skills system with propose/approve workflow
- LLM can propose a skill (pending) and run approved skills (still guardrailed by cooldown + daily quota)

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

