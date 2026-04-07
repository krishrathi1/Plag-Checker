# AI Checker — One-Page Project Brief

## 1) Problem Statement
Academic and professional institutions now face two parallel integrity risks:
- traditional plagiarism (copying/paraphrasing from existing sources)
- AI-generated writing submitted as original human work

Most tools optimize for one side only. AI Checker is built to analyze both in a single workflow with explainable outputs.

## 2) Project Goal
Build an end-to-end integrity platform that accepts common document formats, runs automated analysis, and returns actionable reports with:
- similarity score (plagiarism risk)
- AI probability score
- sentence-level evidence
- source attribution
- forensic integrity signals

## 3) Solution Overview
AI Checker is a full-stack system with:
- React frontend for upload, status tracking, and report review
- TypeScript/Express backend for ingestion, async processing, and report generation
- multi-layer detection pipeline (plagiarism + AI + forensics)

## 4) Core Features
- Async scan jobs (`queued -> processing -> complete/failed`)
- JSON and PDF reports
- sentence-level confidence intervals
- bulk submissions
- org-level stats and audit readiness
- configurable strictness profiles for different operational modes

## 5) Detection Architecture (High-Level)
### Plagiarism Layer
- exact/near-exact matching
- semantic similarity scoring
- character-level overlap analysis

### AI Layer
- stylometric/statistical signals
- temporal consistency and volatility-style signals
- stacked calibrated scoring output

### Forensics Layer
- obfuscation checks (homoglyph/zero-width style manipulations)
- DOCX metadata anomaly checks

## 6) API-First Design
Primary endpoints:
- `POST /v1/submissions`
- `GET /v1/submissions/:jobId`
- `GET /v1/submissions/:jobId/report`
- `GET /v1/submissions/:jobId/report/pdf`
- `POST /v1/submissions/bulk`
- `GET /v1/organisations/:orgId/stats`

## 7) Engineering Highlights
- modular engine design for rapid iteration
- queue-based processing for scalability
- strictness and behavior tuning via environment profiles
- clear separation between detection logic, API, and UI

## 8) Practical Usage Modes
- **Balanced mode**: lower false positives for classroom workflows
- **Strict mode**: stronger screening for institutional review
- **Audit mode**: high-enforcement profile for investigation scenarios

## 9) Current Status
Advanced MVP complete and runnable end-to-end:
- frontend + backend integrated
- upload-to-report flow operational
- configurable detection profiles working
- ready for pilot calibration with real labeled institutional datasets

## 10) Next Steps
- benchmark calibration with institution-specific ground truth
- profile-specific threshold optimization
- improved explainability dashboards for reviewer confidence
- controlled deployment with human-in-the-loop adjudication

## 11) Tech Stack
- Frontend: React, Vite, TypeScript
- Backend: Node.js, Express, TypeScript
- Processing: custom detection engines + async worker pipeline

## 12) Local Run
From project root:

```bash
npm install
npm run dev
```

- API: `http://localhost:8080`
- Frontend: `http://localhost:5173`