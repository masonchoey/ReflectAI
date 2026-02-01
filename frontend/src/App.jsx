import { useState, useEffect } from 'react'

const API_URL = 'http://localhost:8000'

function App() {
  const [entries, setEntries] = useState([])
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editContent, setEditContent] = useState('')

  useEffect(() => {
    fetchEntries()
  }, [])

  const fetchEntries = async () => {
    try {
      setLoading(true)
      const response = await fetch(`${API_URL}/entries`)
      if (!response.ok) throw new Error('Failed to fetch entries')
      const data = await response.json()
      setEntries(data)
      setError(null)
    } catch (err) {
      setError('Could not load entries. Make sure the backend is running.')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!content.trim()) return

    try {
      setSubmitting(true)
      const response = await fetch(`${API_URL}/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.trim() })
      })
      if (!response.ok) throw new Error('Failed to save entry')
      const newEntry = await response.json()
      setEntries([newEntry, ...entries])
      setContent('')
      setError(null)
    } catch (err) {
      setError('Could not save entry. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const formatDate = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    })
  }

  const handleEdit = (entry) => {
    setEditingId(entry.id)
    setEditContent(entry.content)
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditContent('')
  }

  const handleUpdateEntry = async (entryId) => {
    if (!editContent.trim()) return

    try {
      setSubmitting(true)
      const response = await fetch(`${API_URL}/entries/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent.trim() })
      })
      if (!response.ok) throw new Error('Failed to update entry')
      const updatedEntry = await response.json()
      setEntries(entries.map(entry => 
        entry.id === entryId ? updatedEntry : entry
      ))
      setEditingId(null)
      setEditContent('')
      setError(null)
    } catch (err) {
      setError('Could not update entry. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="app">
      <header>
        <h1>ReflectAI</h1>
        <p>Your personal journal for mindful reflection</p>
      </header>

      {error && <div className="error">{error}</div>}

      <form className="journal-form" onSubmit={handleSubmit}>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What's on your mind today? Write your thoughts here..."
          disabled={submitting}
        />
        <button type="submit" disabled={submitting || !content.trim()}>
          {submitting ? 'Saving...' : 'Save Entry'}
        </button>
      </form>

      <section className="entries-section">
        <h2>Your Entries</h2>
        
        {loading ? (
          <div className="loading">Loading entries...</div>
        ) : entries.length === 0 ? (
          <div className="empty-state">
            <p>No entries yet. Start writing your first journal entry above.</p>
          </div>
        ) : (
          <div className="entries-list">
            {entries.map((entry) => (
              <article key={entry.id} className="entry-card">
                <div className="entry-header">
                  <div className="timestamp-container">
                    <span className="timestamp">{formatDate(entry.created_at)}</span>
                    {entry.edited_at && (
                      <span className="edited-timestamp">
                        (Edited: {formatDate(entry.edited_at)})
                      </span>
                    )}
                  </div>
                  {editingId !== entry.id && (
                    <button 
                      className="edit-button"
                      onClick={() => handleEdit(entry)}
                      aria-label="Edit entry"
                    >
                      ✏️ Edit
                    </button>
                  )}
                </div>
                
                {editingId === entry.id ? (
                  <div className="edit-form">
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      disabled={submitting}
                      autoFocus
                    />
                    <div className="edit-buttons">
                      <button 
                        onClick={() => handleUpdateEntry(entry.id)}
                        disabled={submitting || !editContent.trim()}
                        className="save-edit-button"
                      >
                        {submitting ? 'Saving...' : 'Save'}
                      </button>
                      <button 
                        onClick={handleCancelEdit}
                        disabled={submitting}
                        className="cancel-edit-button"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="content">{entry.content}</p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default App
