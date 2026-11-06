#!/usr/bin/env python3
"""Round 2: fix remaining misleading 'video course' format claims.

A verification pass found misleading format claims the first pass
(tools/fix-video-claims.py) missed. No video files exist in any product:
everything ships as a complete written course manual. This script rewrites
every remaining format claim that says a product IS a video course / video
program / video masterclass, includes video lessons, or is the companion /
scripts / text / version of a video course.

Scope: content.md, workbook.md, onboarding.md, listing.json, sales-page.md,
cover.md, README.md (README ships in the buyer ZIP) across all 50 products.
Legitimate teaching content ABOUT video (e.g. marketing modules advising
short videos) and honest disclaimers ("not a video course", "no video is
included") are left alone.

Each replacement is an exact substring match, asserted to occur exactly
once in its file. Run from anywhere: python3 tools/fix-video-claims-round2.py
"""
import sys
from pathlib import Path

PRODUCTS = Path('/home/hatch/workspace/digital-marketplace/products')

# (relative path, old substring, new substring)
FIXES = [
    # ---- listing.json (raw-text replace; preserves each file's formatting) --
    ('BEA-03/listing.json',
     'Includes an 8-module video course in full written form,',
     'Includes an 8-module written course manual,'),
    ('BEA-04/listing.json',
     'A 10-module video course in full written form covering',
     'A 10-module written course manual covering'),
    ('BEA-08/listing.json',
     'Includes a fully written 8-module video-course text with worked examples,',
     'Includes a fully written 8-module course manual with worked examples,'),
    ('PET-02/listing.json',
     'Video course (14 modules, full written scripts included)',
     'Written course manual (14 modules)'),
    ('PET-03/listing.json',
     'Video course (16 modules, 120+ lessons)',
     'Written course manual (16 modules, 120+ lessons)'),
    ('PET-09/listing.json',
     'A 12-module video course companion in full written form (11,000+ words),',
     'A 12-module written course manual (11,000+ words),'),
    ('RE-03/listing.json',
     'A complete 15-module video-course manual for first-time house flippers:',
     'A complete 15-module written course manual for first-time house flippers:'),
    ('RE-07/listing.json',
     'Includes a 12-module video course companion manual with worked examples',
     'Includes a 12-module written course manual with worked examples'),
    ('RE-08/listing.json',
     'An 11-module video course in written form covering direct mail,',
     'An 11-module written course manual covering direct mail,'),

    # ---- content.md --------------------------------------------------------
    ('BEA-03/content.md',
     'This is a video course in written form. Each module is written as a full lesson script:',
     'This is a complete written course manual. Each module is a full lesson in prose:'),
    ('BEA-05/content.md',
     'This is a text-based video-course companion: the full instructional content of all nine modules, written to be read, studied, and referred back to.',
     'This is a complete written course manual: the full instructional content of all nine modules, written to be read, studied, and referred back to.'),
    ('FIN-02/content.md',
     'This manual is the written text of the *First Investor* video course \u2014 all ten modules, in full.',
     'This manual is the complete *First Investor* written course \u2014 all ten modules, in full.'),
    ('FIN-06/content.md',
     'The stated format is a video course of ten modules and nine hours, and this written text is the full instructional companion to that course:',
     'The format is a written course manual of ten modules, and this text is the full course:'),
    ('FIN-07/content.md',
     'This course is designed as a video course companion text of 9 modules and about 7 hours of teaching.',
     'This course is a written course manual of 9 modules.'),
    ('FIN-09/content.md',
     'The course has 10 modules, roughly 8 hours of video teaching in the full video version, and this complete written text is the same teaching in full.',
     'The course has 10 modules, and this complete written text is the full teaching.'),
    ('GRN-03/content.md',
     'This is a self-paced video-course companion in written form.',
     'This is a self-paced written course manual.'),
    ('GRN-04/content.md',
     'This is a written, video-course-style programme in eight modules.',
     'This is a written course manual in eight modules.'),
    ('PET-02/content.md',
     'This document is the complete written version of the 14-module video course. Each module is written as a full teaching script:',
     'This document is the complete written course manual for the 14-module course. Each module is a full lesson in prose:'),
    ('PET-09/content.md',
     'This is a self-paced video-course companion in written form.',
     'This is a self-paced written course manual.'),
    ('RE-07/content.md',
     'This manual is the written companion to the 12-module video course.',
     'This manual is the complete written course manual for the 12-module course.'),
    ('RE-08/content.md',
     'This is a video course in written form: 11 modules,',
     'This is a complete written course manual: 11 modules,'),

    # ---- onboarding.md -----------------------------------------------------
    ('FIN-06/onboarding.md',
     'Read this alongside the 9 hours of video, or follow the course from this text alone.',
     'Read it at your own pace and follow the course from this text alone.'),
    ('FIN-06/onboarding.md',
     '- **The video and the text cover the same course.** Watch the video for a module, then read the matching text to do the exercises, or read the text first and use the video to reinforce it \u2014 whichever suits how you learn.',
     '- **How to use the text.** Read a module, then do the matching workbook exercises before moving on \u2014 whichever order suits how you learn.'),
    ('GRN-02/onboarding.md',
     'the full instructional content of the video course, with worked examples.',
     'the full instructional content of the course, with worked examples.'),
    ('PET-02/onboarding.md',
     '(the video course scripts, complete)',
     '(the complete course text)'),
    ('RE-03/onboarding.md',
     'The full 15-module course manual (the complete video-course text)',
     'The full 15-module written course manual'),

    # ---- sales-page.md -----------------------------------------------------
    ('BEA-02/sales-page.md',
     'A complete 10-module video-course companion for aspiring indie skincare founders',
     'A complete 10-module written course manual for aspiring indie skincare founders'),
    ('BEA-07/sales-page.md',
     '**A 10-module video course (full written course text included):**',
     '**A 10-module written course manual:**'),
    ('FIN-01/sales-page.md',
     '**The 18-module video masterclass (20+ hours).**',
     '**The 18-module written course manual.**'),
    ('FIN-02/sales-page.md',
     'A complete 10-module video course (8 hours) with a portfolio-builder spreadsheet,',
     'A complete 10-module written course manual with a portfolio-builder spreadsheet,'),
    ('FIN-02/sales-page.md',
     '**10 modules, 8 hours of video, with the full course text included as a complete manual:**',
     '**10 modules, with the full course text as a complete manual:**'),
    ('FIN-02/sales-page.md',
     'The video course is 8 hours across 10 modules. Most students finish in two to five weeks',
     'The course is 10 modules. Most students finish in two to five weeks'),
    ('FIN-03/sales-page.md',
     'A full video-course script and manual \u2014 12 complete modules in plain English:',
     'A full written course manual \u2014 12 complete modules in plain English:'),
    ('FIN-05/sales-page.md',
     '**Retire on Purpose** is a 12-module video course with workbooks, calculators, and planners',
     '**Retire on Purpose** is a 12-module written course manual with workbooks, calculators, and planners'),
    ('FIN-06/sales-page.md',
     '**A complete 10-module video course (9 hours) with an income-model selector,',
     '**A complete 10-module written course manual with an income-model selector,'),
    ('FIN-06/sales-page.md',
     '**10 modules, 9 hours of video, with the full instructional text included:**',
     '**10 modules, with the full instructional text included:**'),
    ('FIN-06/sales-page.md',
     'The video course is 10 modules and 9 hours; this written text is the full instructional companion, so you can follow the course from the text alone.',
     'This written text is the full course, so you can follow the course from the text alone.'),
    ('FIN-07/sales-page.md',
     '**Protect Your Family** is a 9-module video course companion (about 7 hours of teaching) that explains',
     '**Protect Your Family** is a 9-module written course manual that explains'),
    ('FIN-08/sales-page.md',
     'A 12-module, 12-hour masterclass for adults who never got a real money education',
     'A 12-module written course manual for adults who never got a real money education'),
    ('FIN-09/sales-page.md',
     'a 10-module, 8-hour video course with the full written course text, a companion workbook, and five ready-to-use templates.',
     'a 10-module written course manual, a companion workbook, and five ready-to-use templates.'),
    ('FIN-09/sales-page.md',
     '**The full course (10 modules, 8 hours of video teaching, with the complete written text included):**',
     '**The full course (10 modules, with the complete written text included):**'),
    ('GRN-01/sales-page.md',
     '**A complete video course and toolkit for city dwellers',
     '**A complete written course manual and toolkit for city dwellers'),
    ('GRN-01/sales-page.md',
     'The Profitable Urban Farm Blueprint is an 11-module video course that teaches you',
     'The Profitable Urban Farm Blueprint is an 11-module written course manual that teaches you'),
    ('GRN-01/sales-page.md',
     '**The full 11-module video course:**',
     '**The full 11-module written course manual:**'),
    ('GRN-02/sales-page.md',
     'The Solar Savings Masterclass is a complete 9-module video course that teaches you,',
     'The Solar Savings Masterclass is a complete 9-module written course manual that teaches you,'),
    ('GRN-04/sales-page.md',
     'This is a written, video-course-style programme: eight full modules written in prose, in the structure of a video course, plus a workbook and templates.',
     'This is a written course manual: eight full modules written in prose, plus a workbook and templates.'),
    ('PET-01/sales-page.md',
     '**The 26-lesson video course text** \u2014 organised as a 7-day launch plan:',
     '**The 26-lesson written course manual** \u2014 organised as a 7-day launch plan:'),
    ('PET-02/sales-page.md',
     '**The full 14-module video course (complete written scripts included):**',
     '**The full 14-module written course manual:**'),
    ('PET-02/sales-page.md',
     'The video course scripts are included in full written form.',
     'The full course text is included in written form.'),
    ('PET-05/sales-page.md',
     'The full course is written in complete prose \u2014 the equivalent of the video course scripts \u2014 so you can read it, search it, and refer back to it.',
     'The full course is written in complete prose, so you can read it, search it, and refer back to it.'),
    ('PET-06/sales-page.md',
     '**Pet Business Marketing Mastery** is a 10-module video course (with full written course content) that walks you through',
     '**Pet Business Marketing Mastery** is a 10-module written course manual that walks you through'),
    ('PET-06/sales-page.md',
     'The course is structured as 10 video-course modules with the full written content included.',
     'The course is a 10-module written course manual with the full written content included.'),
    ('RE-02/sales-page.md',
     '**A complete 14-module video-course manual + workbook + templates.',
     '**A complete 14-module written course manual + workbook + templates.'),
    ('RE-03/sales-page.md',
     'A complete 15-module video-course manual for first-time flippers:',
     'A complete 15-module written course manual for first-time flippers:'),
    ('RE-03/sales-page.md',
     'It is a complete course manual \u2014 the full text of a 15-module video course \u2014 written for an investor',
     'It is a complete written course manual, written for an investor'),
    ('RE-03/sales-page.md',
     'The course manual is the full written text of the 15-module video course \u2014 every module written out in complete prose',
     'The course manual is the complete written course \u2014 every module written out in complete prose'),
    ('RE-04/sales-page.md',
     'A complete 13-module video-course program for homeowners and investors',
     'A complete 13-module written course manual for homeowners and investors'),
    ('RE-07/sales-page.md',
     '### The 12-module video course companion manual',
     '### The 12-module written course manual'),
    ('RE-07/sales-page.md',
     'The product is structured as a 12-module video course with this complete written companion manual, workbook, and templates.',
     'The product is a complete 12-module written course manual, workbook, and templates.'),

    # ---- cover.md ----------------------------------------------------------
    ('FIN-07/cover.md',
     'A 9-module video course (7 hours) for parents and homeowners aged 35\u201360.',
     'A 9-module written course manual for parents and homeowners aged 35\u201360.'),

    # ---- README.md (ships in the buyer ZIP) --------------------------------
    ('FIN-02/README.md',
     'A complete 10-module, 8-hour video course for first-time investors,',
     'A complete 10-module written course manual for first-time investors,'),
    ('FIN-06/README.md',
     '**Format:** Video course (10 modules, 9 hours) + workbook + templates',
     '**Format:** Written course manual (10 modules) + workbook + templates'),
    ('FIN-07/README.md',
     'A 9-module video course (7 hours) for parents and homeowners aged 35\u201360',
     'A 9-module written course manual for parents and homeowners aged 35\u201360'),
    ('GRN-01/README.md',
     'An 11-module video course and toolkit for city dwellers and side-hustlers',
     'An 11-module written course manual and toolkit for city dwellers and side-hustlers'),
    ('GRN-02/README.md',
     'A 9-module video course and toolkit for homeowners who want solar',
     'A 9-module written course manual and toolkit for homeowners who want solar'),
    ('PET-02/README.md',
     'The full 14-module course in written form (video course scripts, complete)',
     'The full 14-module written course manual'),
    ('PET-02/README.md',
     '- **Format:** Video course (14 modules) + comparison matrix',
     '- **Format:** Written course manual (14 modules) + comparison matrix'),
]


def main():
    fixed = []
    for rel, old, new in FIXES:
        p = PRODUCTS / rel
        text = p.read_text(encoding='utf-8')
        n = text.count(old)
        if n == 0:
            if new in text:
                print(f'SKIP {rel}: already applied')
                continue
            print(f'FAIL {rel}: old text not found: {old[:80]!r}')
            sys.exit(1)
        if n != 1:
            print(f'FAIL {rel}: expected exactly 1 occurrence, found {n}: {old[:80]!r}')
            sys.exit(1)
        p.write_text(text.replace(old, new), encoding='utf-8')
        fixed.append(rel)
    print(f'Fixed {len(fixed)} replacements in {len(set(fixed))} files:')
    for f in sorted(set(fixed)):
        print('  -', f)


if __name__ == '__main__':
    main()
