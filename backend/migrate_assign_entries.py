"""
Migration script to assign existing journal entries to a user.

This script:
1. Finds a user by their Google ID or email address
2. Assigns all journal entries with NULL user_id to that user

Usage:
    python migrate_assign_entries.py <google_id_or_email>
    
Examples:
    python migrate_assign_entries.py 123456789012345678901  # Using Google ID
    python migrate_assign_entries.py masonchoey@g.ucla.edu  # Using email
"""

import sys
from sqlalchemy.orm import Session
from database import engine, SessionLocal
from models import Base, User, JournalEntry

def migrate_assign_entries(user_identifier: str):
    """Assign all unassigned journal entries to the specified user."""
    
    # Create tables if they don't exist
    Base.metadata.create_all(bind=engine)
    
    db = SessionLocal()
    try:
        # Try to find the user by Google ID first, then by email
        user = db.query(User).filter(User.google_id == user_identifier).first()
        
        if not user:
            # If not found by Google ID, try email
            user = db.query(User).filter(User.email == user_identifier).first()
        
        if not user:
            print(f"❌ Error: User with identifier '{user_identifier}' not found.")
            print("   (Searched by both Google ID and email)")
            print("   Please sign in to the app first to create your user account.")
            return False
        
        print(f"✅ Found user: {user.name or user.email} (ID: {user.id})")
        
        # Find all entries without a user_id
        unassigned_entries = db.query(JournalEntry).filter(
            JournalEntry.user_id == None
        ).all()
        
        if not unassigned_entries:
            print("ℹ️  No unassigned entries found. All entries are already assigned to users.")
            return True
        
        print(f"\n📝 Found {len(unassigned_entries)} unassigned entries")
        
        # Ask for confirmation
        print(f"\nThis will assign all {len(unassigned_entries)} entries to:")
        print(f"   Name: {user.name or 'N/A'}")
        print(f"   Email: {user.email}")
        print(f"   Google ID: {user.google_id}")
        
        response = input("\nProceed? (yes/no): ").lower().strip()
        
        if response != 'yes':
            print("❌ Migration cancelled.")
            return False
        
        # Assign all entries to the user
        for entry in unassigned_entries:
            entry.user_id = user.id
        
        db.commit()
        
        print(f"\n✅ Successfully assigned {len(unassigned_entries)} entries to {user.email}")
        print("   All done! Your existing journal entries are now associated with your account.")
        
        return True
        
    except Exception as e:
        db.rollback()
        print(f"❌ Error during migration: {str(e)}")
        return False
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python migrate_assign_entries.py <google_id_or_email>")
        print("Examples:")
        print("  python migrate_assign_entries.py 123456789012345678901")
        print("  python migrate_assign_entries.py masonchoey@g.ucla.edu")
        sys.exit(1)
    
    user_identifier = sys.argv[1]
    success = migrate_assign_entries(user_identifier)
    sys.exit(0 if success else 1)
