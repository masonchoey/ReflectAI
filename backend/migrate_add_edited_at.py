"""
Migration script to add edited_at column to journal_entries table
Run this once to update the database schema for existing installations
"""
from sqlalchemy import text
from database import engine

def migrate():
    try:
        with engine.connect() as conn:
            # Check if column already exists
            result = conn.execute(text("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='journal_entries' AND column_name='edited_at'
            """))
            
            if result.fetchone() is None:
                # Add the edited_at column
                conn.execute(text("""
                    ALTER TABLE journal_entries 
                    ADD COLUMN edited_at TIMESTAMP WITH TIME ZONE
                """))
                conn.commit()
                print("✓ Successfully added edited_at column to journal_entries table")
            else:
                print("✓ edited_at column already exists, skipping migration")
    except Exception as e:
        print(f"✗ Migration failed: {e}")
        raise

if __name__ == "__main__":
    migrate()
