#!/usr/bin/env python3
"""Fix misleading 'video course' claims in product source files.

No video files exist in any of the 50 products — the deliverable is the
written course manual (PDF). These fixes correct the copy buyers will see:
- listing.json descriptions (become the live storefront copy) — 13 products
- content.md Format lines (appear inside the buyer-delivered PDF) — 4 products
- FIN-01 Appendix F (premised on videos that do not exist)

Each replacement is an exact string match, asserted to occur exactly once.
Run from anywhere: python3 tools/fix-video-claims.py
"""
import json
import sys
from pathlib import Path

PRODUCTS = Path('/home/hatch/workspace/digital-marketplace/products')

LISTING_FIXES = {
    'BEA-01': (
        'Includes a 12-module video course, fill-in business plan template, service pricing calculator, and launch checklist.',
        'Includes a 12-module written course manual, fill-in business plan template, service pricing calculator, and launch checklist.',
    ),
    'BEA-06': (
        'Includes a 10-module video course, coaching session scripts, and a 12-week client habit programme template.',
        'Includes a 10-module written course manual, coaching session scripts, and a 12-week client habit programme template.',
    ),
    'FIN-01': (
        'Includes an 18-module video masterclass, a 120-page workbook, family wealth dashboard spreadsheets, and legacy letter and family meeting templates.',
        'Includes an 18-module written course manual, a 120-page workbook, family wealth dashboard spreadsheets, and legacy letter and family meeting templates.',
    ),
    'FIN-02': (
        'A complete 10-module, 8-hour video course for first-time investors, with the full course text, a companion workbook, a portfolio-builder spreadsheet, risk-tolerance worksheet, and account-opening checklists.',
        'A complete 10-module written course manual for first-time investors, with a companion workbook, a portfolio-builder spreadsheet, risk-tolerance worksheet, and account-opening checklists.',
    ),
    'FIN-05': (
        'Includes a 12-module video course, retirement income calculators, Social Security timing worksheet, and withdrawal-sequence planner.',
        'Includes a 12-module written course manual, retirement income calculators, Social Security timing worksheet, and withdrawal-sequence planner.',
    ),
    'FIN-06': (
        'A complete 10-module video course (9 hours) for side-hustlers and employed professionals with 5-10 hours a week who want a first income stream beyond their salary.',
        'A complete 10-module written course manual for side-hustlers and employed professionals with 5-10 hours a week who want a first income stream beyond their salary.',
    ),
    'FIN-07': (
        'A complete 9-module video course (7 hours) for parents and homeowners aged 35-60 with children, property, or a small business who have no will or trust in place.',
        'A complete 9-module written course manual for parents and homeowners aged 35-60 with children, property, or a small business who have no will or trust in place.',
    ),
    'FIN-09': (
        'a 10-module, 8-hour video course with the full written course text, a companion workbook, and five ready-to-use templates',
        'a 10-module written course manual, a companion workbook, and five ready-to-use templates',
    ),
    'GRN-01': (
        'A complete 11-module video course for city dwellers and side-hustlers who want to earn income growing food in small urban spaces.',
        'A complete 11-module written course manual for city dwellers and side-hustlers who want to earn income growing food in small urban spaces.',
    ),
    'GRN-02': (
        'A complete 9-module video course for homeowners who want solar without overpaying for it.',
        'A complete 9-module written course manual for homeowners who want solar without overpaying for it.',
    ),
    'PET-01': (
        'Includes a 26-lesson video course, 107-page launch workbook, pricing calculator, and client contracts and booking templates.',
        'Includes a 26-lesson written course manual, 107-page launch workbook, pricing calculator, and client contracts and booking templates.',
    ),
    'PET-02': (
        'Includes a 14-module video course with full written scripts, a business-model comparison matrix, a complete business plan template, a startup budget planner with break-even math, legal and insurance checklists, and a launch checklist.',
        'Includes a 14-module written course manual, a business-model comparison matrix, a complete business plan template, a startup budget planner with break-even math, legal and insurance checklists, and a launch checklist.',
    ),
    'PET-04': (
        'Includes an 18-module video course, breed-cut reference library, grooming safety protocols, and salon pricing calculator.',
        'Includes an 18-module written course manual, breed-cut reference library, grooming safety protocols, and salon pricing calculator.',
    ),
}

CONTENT_FIXES = {
    'BEA-04/content.md': (
        '**Format:** Video course (10 modules) + spreadsheets, handbook and commission templates, rebooking scripts, retail guides, and monthly KPI tracker. This document is the full written text of the video course — every lesson, script, worked example, and exercise in prose, so you can read it, print it, and work through it at your own pace.',
        '**Format:** Written course manual (10 modules) + spreadsheets, handbook and commission templates, rebooking scripts, retail guides, and monthly KPI tracker. This document is the full written text of the course — every lesson, script, worked example, and exercise in prose, so you can read it, print it, and work through it at your own pace.',
    ),
    'FIN-01/content.md': (
        '**Format:** 18-module video masterclass (20+ hours) with this companion text, a 120-page workbook, family wealth dashboard spreadsheets, and legacy letter and family meeting templates.',
        '**Format:** 18-module written course manual, a 120-page workbook, family wealth dashboard spreadsheets, and legacy letter and family meeting templates.',
    ),
    'GRN-02/content.md': (
        '**Format:** Video course (9 modules) with this complete written course text, a companion workbook, a solar sizing and payback calculator, an installer quote comparison worksheet, a federal and state incentive guide, and an off-grid starter checklist.',
        '**Format:** Written course manual (9 modules) — the complete course text, a companion workbook, a solar sizing and payback calculator, an installer quote comparison worksheet, a federal and state incentive guide, and an off-grid starter checklist.',
    ),
    'RE-07/content.md': (
        '**Format:** 12-module video course companion manual, with strategy-fit quiz and decision matrix, strategy comparison guide, glossary of 120 investing terms, and 90-day action plan',
        '**Format:** 12-module written course manual, with strategy-fit quiz and decision matrix, strategy comparison guide, glossary of 120 investing terms, and 90-day action plan',
    ),
}

# FIN-01 Appendix F is premised on videos that do not exist. Retitle it and
# rewrite its opening paragraph around the written manual; the module map,
# pace, and outcomes in the rest of the appendix are unchanged and valid.
FIN01_APPENDIX_TITLE = (
    '## Appendix F — How the Video Masterclass Maps to This Text',
    '## Appendix F — How This Manual Is Organized',
)
FIN01_APPENDIX_PARA = (
    'This companion text contains the full written content of the 18-module video masterclass. Each video module corresponds to a chapter of the same number and title in this text, and the workbook exercise for a module is designed to be completed in the same week as its video. The videos add what text cannot: worked examples completed live on screen, walkthroughs of the dashboard spreadsheet with real data entry, and interviews with a qualified estate attorney and a fee-only financial planner, who answer the questions families ask most often about wills, trusts, and retirement accounts. The text adds what video cannot: tables you can return to, checklists you can print, and projections you can re-run with your own numbers.',
    'This manual contains the complete 18-module course in written form. Each module is a chapter of the same number and title, and the workbook exercise for a module is designed to be completed in the same week as its module. The written format gives you what a lecture cannot: tables you can return to, checklists you can print, and projections you can re-run with your own numbers.',
)
FIN01_HOURS_CLAUSE = (
    "the course's value is in the documents and accounts it produces, not in the hours watched.",
    "the course's value is in the documents and accounts it produces, not in the hours spent reading.",
)


def replace_once(text, old, new, where):
    if old not in text:
        if new in text:
            return text, False  # already applied
        print(f'FAIL {where}: old text not found: {old[:80]!r}')
        sys.exit(1)
    n = text.count(old)
    if n != 1:
        print(f'FAIL {where}: expected exactly 1 occurrence, found {n}: {old[:80]!r}')
        sys.exit(1)
    return text.replace(old, new), True


def main():
    fixed = []
    for sku, (old, new) in LISTING_FIXES.items():
        p = PRODUCTS / sku / 'listing.json'
        d = json.loads(p.read_text())
        if old in d['description']:
            d['description'] = d['description'].replace(old, new)
            p.write_text(json.dumps(d, indent=2) + '\n')
            fixed.append(f'{sku} listing.json')
        elif new in d['description']:
            pass  # already applied
        else:
            print(f'FAIL {sku} listing.json: neither old nor new text in description')
            sys.exit(1)
    for rel, (old, new) in CONTENT_FIXES.items():
        p = PRODUCTS / rel
        text = p.read_text()
        text, changed = replace_once(text, old, new, rel)
        if changed:
            p.write_text(text)
            fixed.append(rel)
    p = PRODUCTS / 'FIN-01' / 'content.md'
    text = p.read_text()
    orig = text
    text, c1 = replace_once(text, *FIN01_APPENDIX_TITLE, 'FIN-01 appendix title')
    text, c2 = replace_once(text, *FIN01_APPENDIX_PARA, 'FIN-01 appendix paragraph')
    text, c3 = replace_once(text, *FIN01_HOURS_CLAUSE, 'FIN-01 hours clause')
    if c1 or c2 or c3:
        p.write_text(text)
        fixed.append('FIN-01/content.md appendix F')
    print(f'Fixed {len(fixed)} items:')
    for f in fixed:
        print('  -', f)


if __name__ == '__main__':
    main()
