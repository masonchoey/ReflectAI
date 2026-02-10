import { useState, useEffect, useCallback, useRef } from 'react'

// Prefer Vite env; fall back to localhost for local dev
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
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
  const [expandedEmotionEntries, setExpandedEmotionEntries] = useState({})
  
  // Tab state
  const [activeTab, setActiveTab] = useState('entries')
  
  // Cluster visualization state
  const [clusteringRuns, setClusteringRuns] = useState([])
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [clusterData, setClusterData] = useState(null)
  const [clusterLoading, setClusterLoading] = useState(false)
  const [hoveredPoint, setHoveredPoint] = useState(null)
  
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
      fetchClusteringRuns()
    }
  }, [user, token])
  
  // Fetch cluster visualization data when run is selected
  useEffect(() => {
    if (selectedRunId && user && token) {
      fetchClusterVisualization(selectedRunId)
    }
  }, [selectedRunId, user, token])

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
  
  const fetchClusteringRuns = async () => {
    try {
      const response = await fetch(`${API_URL}/clustering/runs`, {
        headers: getAuthHeaders()
      })
      if (!response.ok) {
        if (response.status === 401) {
          handleSignOut()
          return
        }
        return // No runs available yet
      }
      const data = await response.json()
      setClusteringRuns(data)
      if (data.length > 0 && !selectedRunId) {
        setSelectedRunId(data[0].id)
      }
    } catch (err) {
      console.error('Could not load clustering runs:', err)
    }
  }
  
  const fetchClusterVisualization = async (runId) => {
    try {
      setClusterLoading(true)
      const response = await fetch(`${API_URL}/clustering/runs/${runId}/visualization`, {
        headers: getAuthHeaders()
      })
      if (!response.ok) {
        if (response.status === 401) {
          handleSignOut()
          return
        }
        // Handle cases where no visualization data exists (404 or 400) gracefully
        if (response.status === 404 || response.status === 400) {
          setClusterData(null)
          setError(null)
          return
        }
        throw new Error('Failed to fetch cluster visualization')
      }
      const data = await response.json()
      setClusterData(data)
      setError(null)
    } catch (err) {
      // Only show error for actual errors, not for missing data
      setError('Could not load cluster visualization. Please try again.')
      setClusterData(null)
    } finally {
      setClusterLoading(false)
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
      setEntries(prevEntries => [newEntry, ...prevEntries])
      setTitle('')
      setContent('')
      setError(null)

      // Run emotion analysis automatically after saving
      void handleAnalyzeEmotion(newEntry.id)
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
      setEntries(prevEntries => prevEntries.map(entry => 
        entry.id === entryId ? updatedEntry : entry
      ))
      setEditingId(null)
      setEditTitle('')
      setEditContent('')
      setError(null)

      // Re-run emotion analysis automatically after updating
      void handleAnalyzeEmotion(entryId)
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
      setEntries(prevEntries => prevEntries.map(entry => 
        entry.id === entryId 
          ? { ...entry, emotion: result.emotion, emotion_score: result.emotion_score }
          : entry
      ))
      
      // Store the full emotion results for display
      setEmotionResults(prev => ({
        ...prev,
        [entryId]: result.all_emotions
      }))

      // Automatically expand the breakdown once it's available
      setExpandedEmotionEntries(prev => ({
        ...prev,
        [entryId]: true
      }))
      
      setError(null)
    } catch (err) {
      setError('Could not analyze emotion. Please try again.')
    } finally {
      setAnalyzingId(null)
    }
  }

  const toggleEmotionBreakdown = (entryId) => {
    setExpandedEmotionEntries(prev => ({
      ...prev,
      [entryId]: !prev[entryId]
    }))
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

      {/* Tabs */}
      <div className="tabs">
        <button
          className={`tab ${activeTab === 'entries' ? 'active' : ''}`}
          onClick={() => setActiveTab('entries')}
        >
          📔 Entries
        </button>
        <button
          className={`tab ${activeTab === 'clusters' ? 'active' : ''}`}
          onClick={() => setActiveTab('clusters')}
        >
          🔍 Clusters
        </button>
      </div>

      {activeTab === 'entries' && (
        <>
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
                        onClick={() => toggleEmotionBreakdown(entry.id)}
                        disabled={analyzingId === entry.id || !emotionResults[entry.id]}
                        aria-label="Toggle emotion breakdown"
                      >
                        {analyzingId === entry.id
                          ? '🔄 Analyzing...'
                          : emotionResults[entry.id]
                            ? (expandedEmotionEntries[entry.id] ? '🙈 Hide Breakdown' : '🔍 View Breakdown')
                            : '🔮 Preparing analysis...'}
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
                        
                        {emotionResults[entry.id] && expandedEmotionEntries[entry.id] && (
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
        </>
      )}

      {activeTab === 'clusters' && (
        <section className="clusters-section">
          <h2>Cluster Visualization</h2>
          
          {clusteringRuns.length === 0 ? (
            <div className="empty-state">
              <p>No clustering runs available. Run clustering on your entries first.</p>
            </div>
          ) : (
            <>
              <div className="cluster-controls">
                <label htmlFor="run-select">Select Clustering Run:</label>
                <select
                  id="run-select"
                  value={selectedRunId || ''}
                  onChange={(e) => setSelectedRunId(parseInt(e.target.value))}
                  className="run-select"
                >
                  {clusteringRuns.map((run) => (
                    <option key={run.id} value={run.id}>
                      {new Date(run.run_timestamp).toLocaleString()} - {run.num_clusters} clusters, {run.num_entries} entries
                    </option>
                  ))}
                </select>
              </div>

              {clusterLoading ? (
                <div className="loading">Loading cluster visualization...</div>
              ) : clusterData ? (
                <ClusterVisualization
                  data={clusterData}
                  hoveredPoint={hoveredPoint}
                  onPointHover={setHoveredPoint}
                />
              ) : (
                <div className="empty-state">
                  <p>No visualization data available for this run.</p>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  )
}

// Cluster Visualization Component
function ClusterVisualization({ data, hoveredPoint, onPointHover }) {
  const svgRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const isPanningRef = useRef(false)
  const lastPosRef = useRef({ x: 0, y: 0 })

  const handleZoomIn = () => {
    setTransform(prev => ({
      ...prev,
      scale: Math.min(prev.scale * 1.25, 5)
    }))
  }

  const handleZoomOut = () => {
    setTransform(prev => ({
      ...prev,
      scale: Math.max(prev.scale / 1.25, 0.4)
    }))
  }

  const handleResetZoom = () => {
    setTransform({ x: 0, y: 0, scale: 1 })
  }

  useEffect(() => {
    const updateDimensions = () => {
      if (svgRef.current) {
        const container = svgRef.current.parentElement
        setDimensions({
          width: Math.min(container.clientWidth - 40, 1000),
          height: Math.max(500, window.innerHeight * 0.6)
        })
      }
    }
    
    updateDimensions()
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  // Calculate bounds and scaling
  const xValues = data.points.map(p => p.x)
  const yValues = data.points.map(p => p.y)
  const xMin = Math.min(...xValues)
  const xMax = Math.max(...xValues)
  const yMin = Math.min(...yValues)
  const yMax = Math.max(...yValues)
  
  const xRange = xMax - xMin || 1
  const yRange = yMax - yMin || 1
  
  const padding = 50
  const scaleX = (dimensions.width - 2 * padding) / xRange
  const scaleY = (dimensions.height - 2 * padding) / yRange
  const scale = Math.min(scaleX, scaleY) * transform.scale

  // Center embeddings within the viewport
  const dataCenterX = (xMin + xMax) / 2
  const dataCenterY = (yMin + yMax) / 2
  const offsetX = dimensions.width / 2 - dataCenterX * scale + transform.x
  const offsetY = dimensions.height / 2 - dataCenterY * scale + transform.y

  // Generate colors for clusters
  const clusterColors = {}
  const uniqueClusters = [...new Set(data.points.map(p => p.cluster_id))].sort((a, b) => {
    // Put noise (-1) at the end
    if (a === -1) return 1
    if (b === -1) return -1
    return a - b
  })
  const colorPalette = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
    '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52BE80',
    '#EC7063', '#5DADE2', '#58D68D', '#F4D03F', '#AF7AC5'
  ]
  
  uniqueClusters.forEach((clusterId, idx) => {
    if (clusterId === -1) {
      clusterColors[clusterId] = '#CCCCCC' // Gray for noise
    } else {
      clusterColors[clusterId] = colorPalette[idx % colorPalette.length]
    }
  })

  const transformPoint = (x, y) => ({
    x: x * scale + offsetX,
    y: y * scale + offsetY
  })

  const tooltipLayout = (() => {
    if (!hoveredPoint) return null
    const base = transformPoint(hoveredPoint.x, hoveredPoint.y)
    const tooltipWidth = 260
    const tooltipHeight = 80
    let x = base.x + 12
    let y = base.y - tooltipHeight - 12

    // Keep tooltip within bounds horizontally
    if (x + tooltipWidth > dimensions.width - 10) {
      x = base.x - tooltipWidth - 12
    }
    if (x < 10) x = 10

    // And vertically
    if (y < 10) {
      y = base.y + 12
    }

    return { x, y, width: tooltipWidth }
  })()

  const handleMouseDown = (event) => {
    isPanningRef.current = true
    lastPosRef.current = { x: event.clientX, y: event.clientY }
  }

  const handleMouseMove = (event) => {
    if (!isPanningRef.current) return
    const deltaX = event.clientX - lastPosRef.current.x
    const deltaY = event.clientY - lastPosRef.current.y
    lastPosRef.current = { x: event.clientX, y: event.clientY }
    setTransform(prev => ({
      ...prev,
      x: prev.x + deltaX,
      y: prev.y + deltaY
    }))
  }

  const endPan = () => {
    isPanningRef.current = false
  }

  return (
    <div className="cluster-viz-container">
      <div className="cluster-zoom-controls">
        <button
          type="button"
          className="cluster-zoom-button"
          onClick={handleZoomOut}
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="cluster-zoom-level">
          {Math.round(transform.scale * 100)}%
        </span>
        <button
          type="button"
          className="cluster-zoom-button"
          onClick={handleZoomIn}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="cluster-zoom-reset"
          onClick={handleResetZoom}
        >
          Reset
        </button>
      </div>

      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        className="cluster-svg"
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endPan}
        onMouseLeave={endPan}
      >
        {/* Grid lines */}
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--border-color)" strokeWidth="0.5" opacity="0.3"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />

        {/* Points */}
        {data.points.map((point) => {
          const pos = transformPoint(point.x, point.y)
          const isHovered = hoveredPoint?.entry_id === point.entry_id
          const color = clusterColors[point.cluster_id] || '#CCCCCC'
          
          return (
            <circle
              key={point.entry_id}
              cx={pos.x}
              cy={pos.y}
              r={isHovered ? 8 : 5}
              fill={color}
              stroke={isHovered ? '#fff' : 'none'}
              strokeWidth={isHovered ? 2 : 0}
              opacity={point.cluster_id === -1 ? 0.3 : 0.8}
              onMouseEnter={() => onPointHover(point)}
              onMouseLeave={() => onPointHover(null)}
              style={{ cursor: 'pointer', transition: 'r 0.2s' }}
            />
          )
        })}
      </svg>

      {hoveredPoint && tooltipLayout && (
        <div
          className="cluster-tooltip"
          style={{
            left: tooltipLayout.x,
            top: tooltipLayout.y,
            width: tooltipLayout.width
          }}
        >
          <div className="cluster-tooltip-title">
            {hoveredPoint.title || 'Untitled Entry'}
          </div>
          <div className="cluster-tooltip-body">
            {hoveredPoint.cluster_name}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="cluster-legend">
        <h3>Clusters</h3>
        <div className="legend-items">
          {data.clusters.map((cluster) => {
            const color = clusterColors[cluster.cluster_id] || '#CCCCCC'
            const name = cluster.topic_label || `Cluster ${cluster.cluster_id}`
            return (
              <div key={cluster.cluster_id} className="legend-item">
                <span
                  className="legend-color"
                  style={{ backgroundColor: color }}
                />
                <span className="legend-label">{name}</span>
                <span className="legend-size">({cluster.size})</span>
              </div>
            )
          })}
          {/* Show noise if present */}
          {data.points.some(p => p.cluster_id === -1) && (
            <div className="legend-item">
              <span
                className="legend-color"
                style={{ backgroundColor: '#CCCCCC' }}
              />
              <span className="legend-label">Noise</span>
              <span className="legend-size">
                ({data.points.filter(p => p.cluster_id === -1).length})
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
