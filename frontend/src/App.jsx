import { useState, useEffect, useCallback } from 'react'

const API_URL = 'http://localhost:8000'
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

function App() {
  const [entries, setEntries] = useState([])
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [analyzingId, setAnalyzingId] = useState(null)
  const [emotionResults, setEmotionResults] = useState({})
  
  // Auth state
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem('auth_token'))
  const [authLoading, setAuthLoading] = useState(true)

  // Get auth headers for API requests
  const getAuthHeaders = useCallback(() => {
    if (!token) return { 'Content-Type': 'application/json' }
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }, [token])

  // Verify existing token on mount
  useEffect(() => {
    const verifyToken = async () => {
      if (!token) {
        setAuthLoading(false)
        return
      }

      try {
        const response = await fetch(`${API_URL}/auth/me`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        
        if (response.ok) {
          const userData = await response.json()
          setUser(userData)
        } else {
          // Token is invalid, clear it
          localStorage.removeItem('auth_token')
          setToken(null)
        }
      } catch (err) {
        console.error('Token verification failed:', err)
        localStorage.removeItem('auth_token')
        setToken(null)
      } finally {
        setAuthLoading(false)
      }
    }

    verifyToken()
  }, [token])

  // Initialize Google Sign-In
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) {
      console.warn('Google Client ID not configured')
      return
    }

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    document.head.appendChild(script)

    script.onload = () => {
      if (window.google) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleGoogleCallback,
          auto_select: false
        })
        
        // Render the sign-in button if not logged in
        if (!user) {
          window.google.accounts.id.renderButton(
            document.getElementById('google-signin-button'),
            { 
              theme: 'filled_black', 
              size: 'large',
              shape: 'pill',
              text: 'continue_with'
            }
          )
        }
      }
    }

    return () => {
      const existingScript = document.querySelector('script[src="https://accounts.google.com/gsi/client"]')
      if (existingScript) {
        existingScript.remove()
      }
    }
  }, [user])

  // Handle Google Sign-In callback
  const handleGoogleCallback = async (response) => {
    try {
      setAuthLoading(true)
      const authResponse = await fetch(`${API_URL}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential })
      })

      if (!authResponse.ok) {
        throw new Error('Authentication failed')
      }

      const data = await authResponse.json()
      localStorage.setItem('auth_token', data.access_token)
      setToken(data.access_token)
      setUser(data.user)
      setError(null)
    } catch (err) {
      setError('Sign in failed. Please try again.')
      console.error('Auth error:', err)
    } finally {
      setAuthLoading(false)
    }
  }

  // Handle sign out
  const handleSignOut = () => {
    localStorage.removeItem('auth_token')
    setToken(null)
    setUser(null)
    setEntries([])
    setEmotionResults({})
    
    // Revoke Google session
    if (window.google) {
      window.google.accounts.id.disableAutoSelect()
    }
  }

  // Fetch entries when user is authenticated
  useEffect(() => {
    if (user && token) {
      fetchEntries()
    }
  }, [user, token])

  const fetchEntries = async () => {
    try {
      setLoading(true)
      const response = await fetch(`${API_URL}/entries`, {
        headers: getAuthHeaders()
      })
      if (!response.ok) {
        if (response.status === 401) {
          handleSignOut()
          return
        }
        throw new Error('Failed to fetch entries')
      }
      const data = await response.json()
      setEntries(data)
      setError(null)
    } catch (err) {
      setError('Could not load entries. Please try again.')
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
        headers: getAuthHeaders(),
        body: JSON.stringify({ 
          title: title.trim() || null,
          content: content.trim() 
        })
      })
      if (!response.ok) {
        if (response.status === 401) {
          handleSignOut()
          return
        }
        throw new Error('Failed to save entry')
      }
      const newEntry = await response.json()
      setEntries([newEntry, ...entries])
      setTitle('')
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
    setEditTitle(entry.title || '')
    setEditContent(entry.content)
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditTitle('')
    setEditContent('')
  }

  const handleUpdateEntry = async (entryId) => {
    if (!editContent.trim()) return

    try {
      setSubmitting(true)
      const response = await fetch(`${API_URL}/entries/${entryId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ 
          title: editTitle.trim() || null,
          content: editContent.trim() 
        })
      })
      if (!response.ok) {
        if (response.status === 401) {
          handleSignOut()
          return
        }
        throw new Error('Failed to update entry')
      }
      const updatedEntry = await response.json()
      setEntries(entries.map(entry => 
        entry.id === entryId ? updatedEntry : entry
      ))
      setEditingId(null)
      setEditTitle('')
      setEditContent('')
      setError(null)
    } catch (err) {
      setError('Could not update entry. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleAnalyzeEmotion = async (entryId) => {
    try {
      setAnalyzingId(entryId)
      const response = await fetch(`${API_URL}/entries/${entryId}/analyze`, {
        method: 'POST',
        headers: getAuthHeaders()
      })
      if (!response.ok) {
        if (response.status === 401) {
          handleSignOut()
          return
        }
        throw new Error('Failed to analyze emotion')
      }
      const result = await response.json()
      
      // Update the entry with the emotion data
      setEntries(entries.map(entry => 
        entry.id === entryId 
          ? { ...entry, emotion: result.emotion, emotion_score: result.emotion_score }
          : entry
      ))
      
      // Store the full emotion results for display
      setEmotionResults(prev => ({
        ...prev,
        [entryId]: result.all_emotions
      }))
      
      setError(null)
    } catch (err) {
      setError('Could not analyze emotion. Please try again.')
    } finally {
      setAnalyzingId(null)
    }
  }

  const getEmotionEmoji = (emotion) => {
    const emojiMap = {
      admiration: '🤩',
      amusement: '😄',
      anger: '😠',
      annoyance: '😒',
      approval: '👍',
      caring: '🤗',
      confusion: '😕',
      curiosity: '🤔',
      desire: '😍',
      disappointment: '😞',
      disapproval: '👎',
      disgust: '🤢',
      embarrassment: '😳',
      excitement: '🎉',
      fear: '😨',
      gratitude: '🙏',
      grief: '😢',
      joy: '😊',
      love: '❤️',
      nervousness: '😰',
      optimism: '🌟',
      pride: '😌',
      realization: '💡',
      relief: '😮‍💨',
      remorse: '😔',
      sadness: '😢',
      surprise: '😲',
      neutral: '😐'
    }
    return emojiMap[emotion] || '🔮'
  }

  // Show loading while checking auth
  if (authLoading) {
    return (
      <div className="app">
        <header>
          <h1>ReflectAI</h1>
          <p>Your personal journal for mindful reflection</p>
        </header>
        <div className="loading">Loading...</div>
      </div>
    )
  }

  // Show sign-in page if not authenticated
  if (!user) {
    return (
      <div className="app">
        <header>
          <h1>ReflectAI</h1>
          <p>Your personal journal for mindful reflection</p>
        </header>

        {error && <div className="error">{error}</div>}

        <div className="auth-container">
          <div className="auth-card">
            <div className="auth-icon">📔</div>
            <h2>Welcome to ReflectAI</h2>
            <p>Sign in to start your personal journaling journey with AI-powered emotion insights.</p>
            
            <div className="auth-features">
              <div className="feature-item">
                <span className="feature-icon">✨</span>
                <span>Private & secure journal entries</span>
              </div>
              <div className="feature-item">
                <span className="feature-icon">🔮</span>
                <span>AI emotion analysis</span>
              </div>
              <div className="feature-item">
                <span className="feature-icon">🔍</span>
                <span>Semantic search across entries</span>
              </div>
            </div>

            <div className="google-signin-wrapper">
              <div id="google-signin-button"></div>
            </div>

            {!GOOGLE_CLIENT_ID && (
              <p className="config-warning">
                ⚠️ Google Client ID not configured. Set VITE_GOOGLE_CLIENT_ID in your .env file.
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Authenticated view
  return (
    <div className="app">
      <header>
        <h1>ReflectAI</h1>
        <p>Your personal journal for mindful reflection</p>
        
        <div className="user-menu">
          <div className="user-info">
            {user.picture && (
              <img 
                src={user.picture} 
                alt={user.name || 'User'} 
                className="user-avatar"
                referrerPolicy="no-referrer"
              />
            )}
            <span className="user-name">{user.name || user.email}</span>
          </div>
          <button onClick={handleSignOut} className="signout-button">
            Sign Out
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <form className="journal-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Entry title (optional)"
          disabled={submitting}
          className="title-input"
          maxLength={200}
        />
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
                <div className="entry-title-section">
                  <h3 className="entry-title">{entry.title || 'Untitled Entry'}</h3>
                </div>
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
                    <div className="entry-actions">
                      <button 
                        className="analyze-button"
                        onClick={() => handleAnalyzeEmotion(entry.id)}
                        disabled={analyzingId === entry.id}
                        aria-label="Analyze emotion"
                      >
                        {analyzingId === entry.id ? '🔄 Analyzing...' : '🔮 Analyze Emotion'}
                      </button>
                      <button 
                        className="edit-button"
                        onClick={() => handleEdit(entry)}
                        aria-label="Edit entry"
                      >
                        ✏️ Edit
                      </button>
                    </div>
                  )}
                </div>
                
                {editingId === entry.id ? (
                  <div className="edit-form">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      placeholder="Entry title (optional)"
                      disabled={submitting}
                      className="title-input"
                      maxLength={200}
                    />
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
                  <>
                    <p className="content">{entry.content}</p>
                    
                    {entry.emotion && (
                      <div className="emotion-display">
                        <div className="primary-emotion">
                          <span className="emotion-emoji">{getEmotionEmoji(entry.emotion)}</span>
                          <span className="emotion-label">{entry.emotion}</span>
                          <span className="emotion-confidence">
                            {(entry.emotion_score * 100).toFixed(1)}% confidence
                          </span>
                        </div>
                        
                        {emotionResults[entry.id] && (
                          <div className="emotion-breakdown">
                            <span className="breakdown-label">Top emotions:</span>
                            <div className="emotion-bars">
                              {emotionResults[entry.id].slice(0, 5).map((emotion, idx) => (
                                <div key={idx} className="emotion-bar-item">
                                  <span className="bar-emoji">{getEmotionEmoji(emotion.label)}</span>
                                  <span className="bar-label">{emotion.label}</span>
                                  <div className="bar-container">
                                    <div 
                                      className="bar-fill"
                                      style={{ width: `${emotion.score * 100}%` }}
                                    />
                                  </div>
                                  <span className="bar-score">{(emotion.score * 100).toFixed(1)}%</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
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
