# backend/test_query.py
from database import engine, SessionLocal
from sqlalchemy import text

# Using raw SQL
with engine.connect() as conn:
    result = conn.execute(text("SELECT 1 as test"))
    print(result.fetchone())  # (1,)

# Or query a table
with engine.connect() as conn:
    result = conn.execute(text("SELECT COUNT(*) FROM journal_entries"))
    print(result.scalar())  # number of journal entries