"""
Migration script to import journal entries from Journal.txt file.

This script:
1. Parses the Journal.txt file to extract entries by date
2. Finds the user by email (mason@choey.com)
3. Imports all entries into the database with proper timestamps

Entry format in Journal.txt:
    M/D/YY - Title (optional hours) (entry_number)
    Content lines...
    
Example:
    1/31/26 - First Date (9 hours) (595)
    Crazy expensive first date but it's okay...

Usage:
    python import_journal_txt.py [--dry-run]
    
Options:
    --dry-run    Preview entries without inserting into database
"""

import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy.orm import Session
from sqlalchemy import func
from database import engine, SessionLocal
from models import Base, User, JournalEntry


RATING_LINE_RE = re.compile(r'^\s*ratings?\s*:\s*.*$', re.IGNORECASE | re.MULTILINE)

# Inline rating snippets sometimes appear mid-line, e.g. "Oh of course, today: Rating: 5/10"
# We remove from "Rating:" (or "Ratings:") through end-of-line.
INLINE_RATING_RE = re.compile(r'(\bratings?\s*:\s*).*$',
                              re.IGNORECASE)

# Header lines commonly look like:
#   "1/31/26 - Title (optional) (595)"
# Sometimes the date has a trailing period, e.g. "8/10/25. - ..."
# We keep the date and title, but strip a trailing "(digits)" entry number (3+ digits).
HEADER_DATE_RE = re.compile(
    r'^\s*\ufeff?(\d{1,2}/\d{1,2}/\d{2,4})\.?\s*-\s*(.*)\s*$'
)
TRAILING_ENTRY_NUM_RE = re.compile(r'\s*\((\d{3,})\)\s*$')

# Some headers also contain progress markers like "(Day 180)" after the title.
# We want to strip those as well from the cleaned journal (and from titles we import),
# while still preserving other parentheses like "(9 hours)".
DAY_MARKER_RE = re.compile(r'\s*\(Day\s+\d+\)\s*$', re.IGNORECASE)

# Helper pattern for cleaning header titles in the *file*:
# remove trailing "(123)" entry numbers (3+ digits) and "(Day 180)" markers.
TRAILING_META_RE = re.compile(r'\s*\((?:\d{3,}|Day\s+\d+)\)\s*$', re.IGNORECASE)


def strip_ratings(text: str) -> str:
    """
    Remove rating annotations from journal text while preserving dates and other content.

    Handles patterns like:
      - "Rating: 7/10"
      - "Ratings: 12/28: 6/10, 12/29: 7/10, ..."
      - Inline "... today: Rating: 5/10" (removes from "Rating:" to end of line)
    """
    if not text:
        return text

    # Normalize newlines for predictable processing
    normalized = text.replace('\r\n', '\n').replace('\r', '\n')

    # Remove any full lines that are rating lines
    without_rating_lines = re.sub(RATING_LINE_RE, '', normalized)

    # Remove inline rating segments
    cleaned_lines = []
    for line in without_rating_lines.split('\n'):
        cleaned_lines.append(re.sub(INLINE_RATING_RE, '', line).rstrip())

    cleaned = '\n'.join(cleaned_lines)

    # Collapse excessive blank lines introduced by removals (keep at most 2)
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned).strip()
    return cleaned


def write_cleaned_journal_file(project_root: Path, raw_text: str) -> Path:
    """Write a cleaned copy of Journal.txt with ratings removed."""
    out_path = project_root / 'Journal_clean.txt'
    cleaned = strip_ratings(raw_text)

    # Additionally remove trailing entry numbers like "(596)" and progress markers
    # like "(Day 180)" from header lines, while preserving the date.
    cleaned_lines: list[str] = []
    for line in cleaned.split('\n'):
        m = HEADER_DATE_RE.match(line)
        if m:
            date_str = m.group(1)
            title_part = m.group(2)
            # Strip trailing "(123)" entry numbers and "(Day 180)" style markers,
            # but keep other parentheses like "(9 hours)" intact.
            title_part = re.sub(TRAILING_META_RE, '', title_part).rstrip()
            cleaned_lines.append(f"{date_str} - {title_part}".rstrip())
        else:
            cleaned_lines.append(line)
    cleaned = '\n'.join(cleaned_lines).strip()

    out_path.write_text(cleaned + '\n', encoding='utf-8')
    return out_path


def parse_journal_file(file_path: str) -> list[dict]:
    """
    Parse the Journal.txt file and extract entries.
    
    Returns a list of dicts with:
        - date: datetime object
        - title: string (without the entry number if present)
        - content: string (full content until next entry)
        - entry_num: int or None (the entry number if present)
    """
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Pattern to match entry headers at the start of a line:
    # Format: M/D/YY - Title or M/DD/YY - Title or MM/DD/YY - Title
    # The title may optionally end with (entry_number) like (595)
    # Examples:
    #   1/31/26 - First Date (9 hours) (595)
    #   5/9/24 - Good things all around
    #   3/14/2024 - FIRST EAGLE EVER
    header_pattern = re.compile(
        r'^(\d{1,2}/\d{1,2}/\d{2,4})\s+-\s+(.+?)$',
        re.MULTILINE
    )
    
    entries = []
    matches = list(header_pattern.finditer(content))
    
    for i, match in enumerate(matches):
        date_str = match.group(1)  # e.g., "1/31/26" or "3/14/2024"
        full_title = match.group(2).strip()  # e.g., "First Date (9 hours) (595)"

        # First strip any trailing "(Day 180)"-style progress markers from the title
        # so they don't end up in the stored title.
        title_no_day = re.sub(DAY_MARKER_RE, '', full_title).strip()
        
        # Check if title ends with an entry number like (595)
        # Pattern: ends with space + (number)
        entry_num_match = re.search(r'\s+\((\d+)\)$', title_no_day)
        if entry_num_match:
            entry_num = int(entry_num_match.group(1))
            title = title_no_day[:entry_num_match.start()].strip()
        else:
            entry_num = None
            title = title_no_day
        
        # Parse the date - handle both 2-digit and 4-digit years
        try:
            parts = date_str.split('/')
            month, day = int(parts[0]), int(parts[1])
            year = int(parts[2])
            # Handle 2-digit year (26 -> 2026, 25 -> 2025, etc.)
            if year < 100:
                year = 2000 + year
            entry_date = datetime(year, month, day, tzinfo=timezone.utc)
        except ValueError as e:
            print(f"⚠️  Warning: Could not parse date '{date_str}': {e}")
            continue
        
        # Get content: everything from after this header to before the next header
        content_start = match.end()
        if i + 1 < len(matches):
            content_end = matches[i + 1].start()
        else:
            content_end = len(content)
        
        entry_content = content[content_start:content_end].strip()
        entry_content = strip_ratings(entry_content)
        
        entries.append({
            'date': entry_date,
            'title': title,
            'content': entry_content,
            'entry_num': entry_num
        })
    
    return entries


def import_entries(entries: list[dict], user_email: str, dry_run: bool = False) -> bool:
    """Import parsed entries into the database for the specified user."""
    
    # Create tables if they don't exist
    Base.metadata.create_all(bind=engine)
    
    db = SessionLocal()
    try:
        # Find the user by email
        user = db.query(User).filter(User.email == user_email).first()
        
        if not user:
            print(f"❌ Error: User with email '{user_email}' not found.")
            print("   Please sign in to the app first to create your user account.")
            return False
        
        print(f"✅ Found user: {user.name or user.email} (ID: {user.id})")
        print(f"\n📝 Parsed {len(entries)} entries from Journal.txt")
        
        if dry_run:
            print("\n🔍 DRY RUN - Preview of entries (first 10):")
            print("-" * 60)
            for entry in entries[:10]:
                num_str = f" (#{entry['entry_num']})" if entry['entry_num'] else ""
                print(f"\n📅 {entry['date'].strftime('%m/%d/%Y')}{num_str}")
                print(f"   Title: {entry['title']}")
                content_preview = entry['content'][:100].replace('\n', ' ')
                print(f"   Content: {content_preview}...")
            if len(entries) > 10:
                print(f"\n   ... and {len(entries) - 10} more entries")
            print("-" * 60)
            print("\n✅ Dry run complete. No changes made.")
            print("   Run without --dry-run to import entries.")
            return True

        regenerate = '--regenerate' in sys.argv
        
        # Ask for confirmation
        print(f"\nThis will import {len(entries)} entries for:")
        print(f"   Name: {user.name or 'N/A'}")
        print(f"   Email: {user.email}")
        print(f"   User ID: {user.id}")
        if regenerate:
            print("   Mode: REGENERATE (will update existing entries that match by title+date)")
        else:
            print("   Mode: IMPORT (will skip entries that already exist by title+date)")
        
        response = input("\nProceed? (yes/no): ").lower().strip()
        
        if response != 'yes':
            print("❌ Import cancelled.")
            return False
        
        # Import entries
        imported_count = 0
        updated_count = 0
        skipped_count = 0
        
        for entry in entries:
            # Match existing by (user_id, title, calendar date) to avoid collisions across years.
            # created_at is stored with timezone; compare by DATE(created_at) == entry date.
            existing = db.query(JournalEntry).filter(
                JournalEntry.user_id == user.id,
                JournalEntry.title == entry['title'],
                func.date(JournalEntry.created_at) == entry['date'].date(),
            ).first()
            
            if existing:
                if regenerate:
                    existing.content = entry['content']
                    existing.created_at = entry['date']
                    # Clear derived fields so downstream pipelines can recompute them.
                    existing.edited_at = None
                    existing.emotion = None
                    existing.emotion_score = None
                    existing.embedding = None
                    updated_count += 1
                else:
                    skipped_count += 1
                continue
            
            # Create new entry
            new_entry = JournalEntry(
                user_id=user.id,
                title=entry['title'],
                content=entry['content'],
                created_at=entry['date'],
                edited_at=None,
                emotion=None,
                emotion_score=None,
                embedding=None
            )
            db.add(new_entry)
            imported_count += 1
        
        db.commit()
        
        print(f"\n✅ Successfully imported {imported_count} entries")
        if updated_count > 0:
            print(f"🔄 Updated {updated_count} existing entries (--regenerate)")
        if skipped_count > 0:
            print(f"ℹ️  Skipped {skipped_count} entries (already exist with same title)")
        print("   All done! Your journal entries have been imported.")
        
        return True
        
    except Exception as e:
        db.rollback()
        print(f"❌ Error during import: {str(e)}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        db.close()


def main():
    # Parse command line arguments
    dry_run = '--dry-run' in sys.argv
    clean_only = '--clean-only' in sys.argv
    regenerate = '--regenerate' in sys.argv
    
    # Get the Journal.txt path (relative to the project root)
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    journal_path = project_root / 'Journal.txt'
    
    if not journal_path.exists():
        print(f"❌ Error: Journal.txt not found at {journal_path}")
        return False
    
    print(f"📖 Reading journal from: {journal_path}")
    
    # Read raw journal once (used for both cleaning + parsing)
    raw_text = journal_path.read_text(encoding='utf-8')
    
    # Always generate a cleaned copy so the user can verify the text
    cleaned_path = write_cleaned_journal_file(project_root, raw_text)
    print(f"🧼 Wrote cleaned journal (ratings removed) to: {cleaned_path}")
    
    if clean_only:
        print("✅ Clean-only mode complete. No database import performed.")
        return True
    if regenerate:
        print("🔄 Regenerate enabled: existing entries will be updated by title+date.")
    
    # Parse the journal file
    entries = parse_journal_file(str(journal_path))
    
    if not entries:
        print("❌ Error: No entries found in Journal.txt")
        return False
    
    # Sort entries by date (oldest first) for consistent ordering
    # Use entry_num as secondary sort key if available
    entries.sort(key=lambda x: (x['date'], x['entry_num'] or 0))
    
    # Import entries for mason@choey.com
    user_email = 'mason@choey.com'
    
    return import_entries(entries, user_email, dry_run)


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
