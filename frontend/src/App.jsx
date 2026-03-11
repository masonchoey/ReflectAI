import { useState, useEffect, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createClient } from '@supabase/supabase-js'

// Prefer Vite env; fall back based on environment
// In production (Fly), use the Fly API URL; in development, use localhost
const API_URL = import.meta.env.VITE_API_URL || (
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8000'
    : 'https://reflectai-api-icy-dust-4243.fly.dev'
)
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || ''
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
const IS_LOCALHOST =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
const SHOULD_USE_SUPABASE = !IS_LOCALHOST && !!SUPABASE_URL && !!SUPABASE_ANON_KEY

const supabase = SHOULD_USE_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null

const CLUSTER_PARAMS_STORAGE_KEY = 'reflectai_cluster_params'

const DEFAULT_CLUSTER_PARAMS = {
  minClusterSize: 2,
  minSamples: 1,
  membershipThreshold: 0.05,
  clusterSelectionEpsilon: 0.0,
  umapNComponents: 5,
  umapNNeighbors: 8,
  umapMinDist: 0.0
}

const CLUSTER_PARAMS_BOUNDS = {
  minClusterSize: { min: 2, max: 20 },
  minSamples: { min: 1, max: 10 },
  membershipThreshold: { min: 0.05, max: 0.5 },
  clusterSelectionEpsilon: { min: 0, max: 1 },
  umapNComponents: { min: 5, max: 30 },
  umapNNeighbors: { min: 5, max: 50 },
  umapMinDist: { min: 0, max: 1 }
}

function loadClusterParamsFromStorage(userId) {
  try {
    const key = `${CLUSTER_PARAMS_STORAGE_KEY}_${userId}`
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const out = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (!(key in CLUSTER_PARAMS_BOUNDS)) continue
      const { min, max } = CLUSTER_PARAMS_BOUNDS[key]
      const num = Number(val)
      if (Number.isFinite(num)) out[key] = Math.min(max, Math.max(min, num))
    }
    return Object.keys(out).length === Object.keys(CLUSTER_PARAMS_BOUNDS).length ? out : null
  } catch {
    return null
  }
}

function saveClusterParamsToStorage(userId, params) {
  try {
    const key = `${CLUSTER_PARAMS_STORAGE_KEY}_${userId}`
    localStorage.setItem(key, JSON.stringify(params))
  } catch (e) {
    console.warn('Failed to save cluster params to localStorage', e)
  }
}

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
  const [dateRangeType, setDateRangeType] = useState('all') // 'all', '7days', '30days', '90days', 'custom'
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [runningClustering, setRunningClustering] = useState(false)
  const [clusteringTaskId, setClusteringTaskId] = useState(null)
  const [clusteringTaskStatus, setClusteringTaskStatus] = useState(null)
  
  // Clustering parameters - optimized for many fine-grained clusters
  const [minClusterSize, setMinClusterSize] = useState(2)  // Reduced to 2 for more clusters
  const [minSamples, setMinSamples] = useState(1)
  const [membershipThreshold, setMembershipThreshold] = useState(0.05)
  const [clusterSelectionEpsilon, setClusterSelectionEpsilon] = useState(0.0)
  const [umapNComponents, setUmapNComponents] = useState(5)  // Reduced to 5 for more structure
  const [umapNNeighbors, setUmapNNeighbors] = useState(8)  // Reduced to 8 for more local clusters
  const [umapMinDist, setUmapMinDist] = useState(0.0)
  
  // Therapy questions state
  const [therapyQuestion, setTherapyQuestion] = useState('')
  const [therapyTaskId, setTherapyTaskId] = useState(null)
  const [therapyLoading, setTherapyLoading] = useState(false)
  const [therapyConversation, setTherapyConversation] = useState([]) // [{role, content, steps}]
  const [therapyStepsExpanded, setTherapyStepsExpanded] = useState({}) // {messageIdx: bool}
  const [currentConversationId, setCurrentConversationId] = useState(null)
  const [conversationHistory, setConversationHistory] = useState([]) // list of past conversations
  const [historyLoading, setHistoryLoading] = useState(false)
  const messagesEndRef = useRef(null)
  // Recommended settings state
  const [recommendLoading, setRecommendLoading] = useState(false)
  const [recommendReasoning, setRecommendReasoning] = useState(null)

  // Admin bulk-analyze state
  const [bulkAnalyzing, setBulkAnalyzing] = useState(false)
  const [bulkAnalyzeProgress, setBulkAnalyzeProgress] = useState(null)
  const [bulkAnalyzeTarget, setBulkAnalyzeTarget] = useState('')

  // Auth state
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(() => localStorage.getItem('auth_token'))
  const [authLoading, setAuthLoading] = useState(true)
  const skipNextClusterParamsSaveRef = useRef(false)

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

  // Load persisted cluster params when user is set
  useEffect(() => {
    if (!user?.id) return
    const saved = loadClusterParamsFromStorage(user.id)
    if (!saved) return
    setMinClusterSize(saved.minClusterSize)
    setMinSamples(saved.minSamples)
    setMembershipThreshold(saved.membershipThreshold)
    setClusterSelectionEpsilon(saved.clusterSelectionEpsilon)
    setUmapNComponents(saved.umapNComponents)
    setUmapNNeighbors(saved.umapNNeighbors)
    setUmapMinDist(saved.umapMinDist)
    skipNextClusterParamsSaveRef.current = true
  }, [user?.id])

  // Persist cluster params when they change (and user is logged in)
  useEffect(() => {
    if (!user?.id) return
    if (skipNextClusterParamsSaveRef.current) {
      skipNextClusterParamsSaveRef.current = false
      return
    }
    saveClusterParamsToStorage(user.id, {
      minClusterSize,
      minSamples,
      membershipThreshold,
      clusterSelectionEpsilon,
      umapNComponents,
      umapNNeighbors,
      umapMinDist
    })
  }, [user?.id, minClusterSize, minSamples, membershipThreshold, clusterSelectionEpsilon, umapNComponents, umapNNeighbors, umapMinDist])

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

      if (SHOULD_USE_SUPABASE && supabase) {
        try {
          await supabase.auth.signInWithIdToken({
            provider: 'google',
            token: response.credential
          })
        } catch (supabaseError) {
          console.error('Supabase sign-in with Google ID token failed:', supabaseError)
        }
      }
    } catch (err) {
      setError('Sign in failed. Please try again.')
      console.error('Auth error:', err)
    } finally {
      setAuthLoading(false)
    }
  }

  // Handle sign out
  const handleSignOut = () => {
    if (user?.id) {
      localStorage.removeItem(`${CLUSTER_PARAMS_STORAGE_KEY}_${user.id}`)
    }
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

  // Load conversation history when therapy tab opens
  useEffect(() => {
    if (activeTab === 'therapy' && user && token) {
      loadConversationHistory()
    }
  }, [activeTab, user, token])

  // Auto-scroll to latest message
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [therapyConversation, therapyLoading])

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
      // Pre-populate the breakdown state so the dropdown is instant (no ML re-run needed)
      const preloaded = {}
      data.forEach(entry => {
        if (entry.all_emotions && entry.all_emotions.length > 0) {
          preloaded[Number(entry.id)] = entry.all_emotions
        }
      })
      setEmotionResults(prev => ({ ...prev, ...preloaded }))
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

  const fetchRecommendedSettings = async () => {
    setRecommendLoading(true)
    setRecommendReasoning(null)
    try {
      const response = await fetch(`${API_URL}/clustering/recommend`, {
        headers: getAuthHeaders(),
      })
      if (!response.ok) {
        if (response.status === 401) {
          handleSignOut()
          return
        }
        throw new Error('Failed to fetch recommended settings')
      }
      const data = await response.json()
      const p = data.params
      setMinClusterSize(p.min_cluster_size)
      setMinSamples(p.min_samples)
      setMembershipThreshold(p.membership_threshold)
      setClusterSelectionEpsilon(p.cluster_selection_epsilon)
      setUmapNComponents(p.umap_n_components)
      setUmapNNeighbors(p.umap_n_neighbors)
      setUmapMinDist(p.umap_min_dist)
      setRecommendReasoning(data.reasoning)
    } catch (err) {
      setRecommendReasoning('Could not load recommendations. Please try again.')
    } finally {
      setRecommendLoading(false)
    }
  }

  const runClustering = async () => {
    try {
      setRunningClustering(true)
      setError(null)
      setClusteringTaskStatus(null)
      
      // Calculate dates based on dateRangeType
      let requestStartDate = null
      let requestEndDate = null
      
      if (dateRangeType === 'custom') {
        if (startDate) {
          requestStartDate = new Date(startDate).toISOString()
        }
        if (endDate) {
          // Set to end of day
          const end = new Date(endDate)
          end.setHours(23, 59, 59, 999)
          requestEndDate = end.toISOString()
        }
      } else if (dateRangeType !== 'all') {
        const days = parseInt(dateRangeType)
        const end = new Date()
        end.setHours(23, 59, 59, 999)
        requestEndDate = end.toISOString()
        
        const start = new Date()
        start.setDate(start.getDate() - days)
        start.setHours(0, 0, 0, 0)
        requestStartDate = start.toISOString()
      }
      
      const requestBody = {
        min_cluster_size: minClusterSize,
        min_samples: minSamples,
        membership_threshold: membershipThreshold,
        cluster_selection_epsilon: clusterSelectionEpsilon,
        umap_n_components: umapNComponents,
        umap_n_neighbors: umapNNeighbors,
        umap_min_dist: umapMinDist,
      }
      if (requestStartDate) requestBody.start_date = requestStartDate
      if (requestEndDate) requestBody.end_date = requestEndDate
      
      const response = await fetch(`${API_URL}/clustering/run`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(requestBody)
      })
      
      if (!response.ok) {
        if (response.status === 401) {
          handleSignOut()
          return
        }
        const errorData = await response.json().catch(() => ({ detail: 'Failed to queue clustering task' }))
        throw new Error(errorData.detail || 'Failed to queue clustering task')
      }
      
      const taskData = await response.json()
      setClusteringTaskId(taskData.task_id)
      setClusteringTaskStatus(taskData.status)
      
    } catch (err) {
      setError(err.message || 'Could not run clustering. Please try again.')
      setRunningClustering(false)
      setClusteringTaskId(null)
      setClusteringTaskStatus(null)
    }
  }

  // Poll for clustering task status
  useEffect(() => {
    if (!clusteringTaskId) return

    const pollTaskStatus = async () => {
      try {
        const response = await fetch(`${API_URL}/tasks/${clusteringTaskId}`, {
          headers: getAuthHeaders()
        })
        
        if (!response.ok) {
          if (response.status === 401) {
            handleSignOut()
            return
          }
          return
        }
        
        const taskData = await response.json()
        setClusteringTaskStatus(taskData.status)
        
        if (taskData.status === 'SUCCESS') {
          // Task completed successfully
          setRunningClustering(false)
          setClusteringTaskId(null)
          
          // Refresh clustering runs list
          await fetchClusteringRuns()
          
          // If the task result contains a run_id, select it
          if (taskData.result && taskData.result.run_id) {
            setSelectedRunId(taskData.result.run_id)
          }
        } else if (taskData.status === 'FAILURE' || taskData.status === 'REVOKED') {
          // Task failed
          setRunningClustering(false)
          setClusteringTaskId(null)
          setError(taskData.error || 'Clustering task failed. Please try again.')
        }
        // If task is still PENDING or STARTED, continue polling
      } catch (err) {
        console.error('Error polling task status:', err)
      }
    }

    // Poll immediately, then every 2 seconds
    pollTaskStatus()
    const interval = setInterval(pollTaskStatus, 2000)

    return () => clearInterval(interval)
  }, [clusteringTaskId, token, getAuthHeaders, fetchClusteringRuns, handleSignOut])

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
        throw new Error('Failed to queue emotion analysis')
      }
      const taskData = await response.json()
      const taskId = taskData.task_id

      // Poll for task completion
      const poll = async () => {
        try {
          const statusRes = await fetch(`${API_URL}/tasks/${taskId}`, {
            headers: getAuthHeaders()
          })
          if (!statusRes.ok) {
            if (statusRes.status === 401) { handleSignOut(); return }
            throw new Error('Failed to fetch task status')
          }
          const status = await statusRes.json()

          if (status.status === 'SUCCESS' && status.result) {
            const result = status.result
            // Use result.entry_id from backend as source of truth so we update the correct entry
            const id = Number(result.entry_id ?? entryId)
            setEntries(prevEntries => prevEntries.map(entry =>
              Number(entry.id) === id
                ? { ...entry, emotion: result.emotion, emotion_score: result.emotion_score }
                : entry
            ))
            setEmotionResults(prev => ({ ...prev, [id]: result.all_emotions }))
            setExpandedEmotionEntries(prev => ({ ...prev, [id]: true }))
            setError(null)
            setAnalyzingId(prev => (prev === entryId || prev === id ? null : prev))
          } else if (status.status === 'FAILURE' || status.status === 'REVOKED') {
            throw new Error(status.error || 'Emotion analysis task failed')
          } else {
            // Still PENDING or STARTED — keep polling
            setTimeout(poll, 2000)
          }
        } catch (err) {
          setError('Could not analyze emotion. Please try again.')
          setAnalyzingId(null)
        }
      }

      // Start polling after a short initial delay
      setTimeout(poll, 1000)
    } catch (err) {
      setError('Could not analyze emotion. Please try again.')
      setAnalyzingId(null)
    }
  }

  const THERAPY_EXAMPLE_QUESTIONS = [
    "What patterns do you notice in how I handle stress or difficult moments?",
    "Based on my journal entries, what brings me the most joy and fulfillment?",
    "What recurring themes or challenges keep showing up in my life?",
    "How have my emotions and mood evolved over the past few months?",
    "What do my journal entries reveal about my relationships and social life?",
    "Where do I seem to be growing the most as a person?",
    "What fears or anxieties come up most often in my writing?",
    "What values and priorities seem most important to me based on what I write about?",
  ]

  const saveConversationMessage = async (role, content, steps = null, isError = false, convId = null) => {
    try {
      const res = await fetch(`${API_URL}/conversations/messages`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          conversation_id: convId,
          role,
          content,
          steps,
          is_error: isError,
        }),
      })
      if (!res.ok) return null
      const data = await res.json()
      return data
    } catch {
      return null
    }
  }

  const loadConversationHistory = async () => {
    if (!token) return
    setHistoryLoading(true)
    try {
      const res = await fetch(`${API_URL}/conversations`, { headers: getAuthHeaders() })
      if (res.ok) {
        const data = await res.json()
        setConversationHistory(data)
      }
    } catch {
      // silently fail
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadConversation = async (convId) => {
    try {
      const res = await fetch(`${API_URL}/conversations/${convId}`, { headers: getAuthHeaders() })
      if (!res.ok) return
      const data = await res.json()
      setCurrentConversationId(data.id)
      setTherapyConversation(data.messages.map(m => ({
        role: m.role,
        content: m.content,
        steps: m.steps || [],
        isError: m.is_error,
      })))
      setTherapyStepsExpanded({})
      setShowHistory(false)
    } catch {
      // silently fail
    }
  }

  const askTherapyQuestion = async (questionText) => {
    const q = (questionText || therapyQuestion).trim()
    if (!q || therapyLoading) return

    setTherapyConversation(prev => [...prev, { role: 'user', content: q }])
    setTherapyQuestion('')
    setTherapyLoading(true)

    // Persist the user message and get/create the conversation ID
    let convId = currentConversationId
    const saved = await saveConversationMessage('user', q, null, false, convId)
    if (saved) {
      convId = saved.conversation_id
      setCurrentConversationId(convId)
    }

    try {
      const response = await fetch(`${API_URL}/therapy/ask`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ question: q }),
      })
      if (!response.ok) {
        if (response.status === 401) { handleSignOut(); return }
        throw new Error('Failed to queue therapy question')
      }
      const taskData = await response.json()
      setTherapyTaskId(taskData.task_id)
      ensure_worker_running_if_available()

      const pollTherapy = async () => {
        try {
          const statusRes = await fetch(`${API_URL}/tasks/${taskData.task_id}`, {
            headers: getAuthHeaders(),
          })
          if (!statusRes.ok) {
            if (statusRes.status === 401) { handleSignOut(); return }
            throw new Error('Failed to fetch therapy task status')
          }
          const status = await statusRes.json()

          if (status.status === 'SUCCESS' && status.result) {
            const result = status.result
            const assistantContent = result.answer || 'I was unable to generate a response.'
            const assistantSteps = result.steps || []
            setTherapyConversation(prev => [
              ...prev,
              { role: 'assistant', content: assistantContent, steps: assistantSteps },
            ])
            setTherapyLoading(false)
            setTherapyTaskId(null)
            saveConversationMessage('assistant', assistantContent, assistantSteps, false, convId)
            loadConversationHistory()
          } else if (status.status === 'FAILURE' || status.status === 'REVOKED') {
            const errContent = 'I encountered an error while processing your question. Please try again.'
            setTherapyConversation(prev => [
              ...prev,
              { role: 'assistant', content: errContent, steps: [], isError: true },
            ])
            setTherapyLoading(false)
            setTherapyTaskId(null)
            saveConversationMessage('assistant', errContent, [], true, convId)
          } else {
            setTimeout(pollTherapy, 2500)
          }
        } catch (err) {
          console.error('Error polling therapy task:', err)
          setTimeout(pollTherapy, 3000)
        }
      }

      setTimeout(pollTherapy, 1500)
    } catch (err) {
      const errContent = 'Failed to connect. Please try again.'
      setTherapyConversation(prev => [
        ...prev,
        { role: 'assistant', content: errContent, steps: [], isError: true },
      ])
      setTherapyLoading(false)
      saveConversationMessage('assistant', errContent, [], true, convId)
    }
  }

  // eslint-disable-next-line no-unused-vars
  const ensure_worker_running_if_available = () => {}

  const toggleTherapySteps = (idx) => {
    setTherapyStepsExpanded(prev => ({ ...prev, [idx]: !prev[idx] }))
  }

  const getToolIcon = (toolName) => {
    const icons = {
      search_journals: '🔍',
      get_recent_entries: '📅',
      get_entries_by_emotion: '💫',
      get_journal_themes: '🗺️',
      get_emotional_timeline: '📈',
      get_journal_statistics: '📊',
    }
    return icons[toolName] || '🔧'
  }

  const getToolLabel = (toolName) => {
    const labels = {
      search_journals: 'Searched journals',
      get_recent_entries: 'Retrieved recent entries',
      get_entries_by_emotion: 'Filtered by emotion',
      get_journal_themes: 'Analysed themes',
      get_emotional_timeline: 'Reviewed emotional timeline',
      get_journal_statistics: 'Checked statistics',
    }
    return labels[toolName] || toolName
  }
  const handleBulkAnalyze = async () => {
    try {
      setBulkAnalyzing(true)
      setBulkAnalyzeProgress({ queued: 0, completed: 0, failed: 0, total: 0 })

      const trimmed = bulkAnalyzeTarget.trim()
      const body = {}
      if (trimmed !== '') {
        const asNum = parseInt(trimmed, 10)
        if (String(asNum) === trimmed) {
          body.user_id = asNum
        } else {
          body.email = trimmed
        }
      }

      const response = await fetch(`${API_URL}/admin/bulk-analyze`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(body)
      })
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        const msg = typeof errData.detail === 'string' ? errData.detail : 'Failed to queue bulk analysis'
        throw new Error(msg)
      }

      const data = await response.json()
      const { task_ids, entry_ids, queued } = data

      if (queued === 0) {
        setBulkAnalyzeProgress({ queued: 0, completed: 0, failed: 0, total: 0, done: true })
        setBulkAnalyzing(false)
        return
      }

      setBulkAnalyzeProgress({ queued, completed: 0, failed: 0, total: queued, done: false })

      let completed = 0
      let failed = 0

      const pollTask = (taskId, entryId) => new Promise((resolve) => {
        const poll = async () => {
          try {
            const statusRes = await fetch(`${API_URL}/tasks/${taskId}`, { headers: getAuthHeaders() })
            if (!statusRes.ok) { failed++; setBulkAnalyzeProgress(p => ({ ...p, failed })); resolve(); return }
            const status = await statusRes.json()

            if (status.status === 'SUCCESS' && status.result) {
              const result = status.result
              const id = Number(result.entry_id ?? entryId)
              setEntries(prev => prev.map(e =>
                Number(e.id) === id
                  ? { ...e, emotion: result.emotion, emotion_score: result.emotion_score }
                  : e
              ))
              setEmotionResults(prev => ({ ...prev, [id]: result.all_emotions }))
              completed++
              setBulkAnalyzeProgress(p => ({ ...p, completed }))
              resolve()
            } else if (status.status === 'FAILURE' || status.status === 'REVOKED') {
              failed++
              setBulkAnalyzeProgress(p => ({ ...p, failed }))
              resolve()
            } else {
              setTimeout(poll, 2000)
            }
          } catch {
            failed++
            setBulkAnalyzeProgress(p => ({ ...p, failed }))
            resolve()
          }
        }
        setTimeout(poll, 1000)
      })

      await Promise.all(task_ids.map((taskId, i) => pollTask(taskId, entry_ids[i])))
      setBulkAnalyzeProgress(p => ({ ...p, done: true }))
      setBulkAnalyzing(false)
    } catch (err) {
      setError('Bulk analysis failed. Please try again.')
      setBulkAnalyzing(false)
      setBulkAnalyzeProgress(null)
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
        <header className="app-header app-header--compact">
          <div className="header-left">
            <h1>ReflectAI</h1>
            <p className="header-tagline">Your personal journal for mindful reflection</p>
          </div>
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
      <header className="app-header">
        <div className="header-left">
          <h1>ReflectAI</h1>
          <p className="header-tagline">Your personal journal for mindful reflection</p>
        </div>
        <div className="header-right">
          <div className="user-menu">
            <div className="user-info">
              {user.email === 'mason@choey.com' && (
                <span className="admin-badge">ADMIN</span>
              )}
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
          {user.email === 'mason@choey.com' && (
            <div className="admin-panel">
              <button
                onClick={handleBulkAnalyze}
                disabled={bulkAnalyzing}
                className="admin-bulk-analyze-button"
                title="Admin: Run sentiment analysis on unanalyzed entries for the specified user (or you if blank)"
              >
                {bulkAnalyzing ? '⚙ Analyzing…' : '⚙ Bulk Analyze'}
              </button>
              {bulkAnalyzeProgress && (
                <span className="admin-bulk-progress">
                  {bulkAnalyzeProgress.done
                    ? bulkAnalyzeProgress.total === 0
                      ? 'All entries already analyzed'
                      : `Done — ${bulkAnalyzeProgress.completed}/${bulkAnalyzeProgress.total} analyzed${bulkAnalyzeProgress.failed > 0 ? `, ${bulkAnalyzeProgress.failed} failed` : ''}`
                    : `${bulkAnalyzeProgress.completed}/${bulkAnalyzeProgress.total} analyzed…`}
                </span>
              )}
              <input
                type="text"
                value={bulkAnalyzeTarget}
                onChange={(e) => setBulkAnalyzeTarget(e.target.value)}
                placeholder="User ID or email (blank = you)"
                disabled={bulkAnalyzing}
                className="admin-bulk-analyze-input"
                aria-label="User ID or email for bulk analyze"
              />
            </div>
          )}
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
        <button
          className={`tab ${activeTab === 'therapy' ? 'active' : ''}`}
          onClick={() => setActiveTab('therapy')}
        >
          🧠 Therapy Questions
        </button>
      </div>

      {activeTab === 'entries' && (
        <div className="entries-layout">
          <section className="entries-section">
            <h2>Your Entries</h2>
            
            {loading ? (
              <div className="loading">Loading entries...</div>
            ) : entries.length === 0 ? (
              <div className="empty-state">
                <p>No entries yet. Start writing your first journal entry.</p>
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
                          {!entry.emotion && (
                            <button 
                              className="analyze-button"
                              onClick={() => handleAnalyzeEmotion(entry.id)}
                              disabled={analyzingId === entry.id}
                              aria-label="Analyze emotion"
                            >
                              {analyzingId === entry.id ? '🔄 Analyzing emotion...' : '🔮 Analyze emotion'}
                            </button>
                          )}
                          {entry.emotion && (
                            <button 
                              className="analyze-button"
                              onClick={() => toggleEmotionBreakdown(entry.id)}
                              aria-label="Toggle emotion breakdown"
                            >
                              {expandedEmotionEntries[entry.id] ? '🙈 Hide Breakdown' : '🔍 View Breakdown'}
                            </button>
                          )}
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
                            <button
                              type="button"
                              className="emotion-dropdown-trigger"
                              onClick={() => toggleEmotionBreakdown(entry.id)}
                              aria-expanded={!!expandedEmotionEntries[entry.id]}
                              aria-label="Toggle emotion breakdown"
                            >
                              <span className="emotion-emoji">{getEmotionEmoji(entry.emotion)}</span>
                              <span className="emotion-label">{entry.emotion}</span>
                              <span className="emotion-confidence">
                                {(entry.emotion_score * 100).toFixed(1)}% confidence
                              </span>
                              <span className={`emotion-chevron ${expandedEmotionEntries[entry.id] ? 'open' : ''}`} aria-hidden>▼</span>
                            </button>
                            
                            {expandedEmotionEntries[entry.id] && (
                              <div className="emotion-breakdown">
                                {emotionResults[entry.id] ? (
                                  <>
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
                                  </>
                                ) : (
                                  <span className="breakdown-loading">Loading…</span>
                                )}
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

          <form className="journal-form" onSubmit={handleSubmit}>
            <h2>New Entry</h2>
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
        </div>
      )}

      {activeTab === 'clusters' && (
        <section className="clusters-section">
          <h2>Cluster Visualization</h2>
          
          {clusteringRuns.length === 0 ? (
            <div className="cluster-layout-container">
          <div className="cluster-run-controls">
            <h3>Run Clustering</h3>
            
            <div className="form-group">
              <label htmlFor="date-range-type">Time Period:</label>
              <select
                id="date-range-type"
                value={dateRangeType}
                onChange={(e) => setDateRangeType(e.target.value)}
              >
                <option value="all">All Entries</option>
                <option value="7">Last 7 Days</option>
                <option value="30">Last 30 Days</option>
                <option value="90">Last 90 Days</option>
                <option value="custom">Custom Range</option>
              </select>
            </div>
            
            {dateRangeType === 'custom' && (
              <div className="custom-date-range">
                <div className="form-group">
                  <label htmlFor="start-date">Start Date:</label>
                  <input
                    id="start-date"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="end-date">End Date:</label>
                  <input
                    id="end-date"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
            )}
                
                <div className="clustering-parameters">
                  <h4>Clustering Parameters</h4>
                  <p className="parameters-description">
                    Adjust these parameters to fine-tune clustering results. HDBSCAN parameters control cluster formation, while UMAP parameters control dimensionality reduction before clustering.
                  </p>
                  <div className="suggest-settings-row">
                    <button
                      onClick={fetchRecommendedSettings}
                      disabled={recommendLoading}
                      className="suggest-settings-btn"
                    >
                      {recommendLoading ? 'Analyzing…' : '✦ Suggest Settings'}
                    </button>
                    {recommendReasoning && (
                      <p className="recommend-hint">{recommendReasoning}</p>
                    )}
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="min-cluster-size">
                      Min Cluster Size: <strong>{minClusterSize}</strong>
                    </label>
                    <div className="parameter-info">
                      Minimum number of entries required to form a cluster. Lower values (2-4) create more fine-grained clusters. Higher values (8-15) create fewer, larger clusters.
                    </div>
                    <input
                      id="min-cluster-size"
                      type="range"
                      min="2"
                      max="20"
                      value={minClusterSize}
                      onChange={(e) => setMinClusterSize(parseInt(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>2 (More clusters)</span>
                      <span>20 (Fewer clusters)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="min-samples">
                      Min Samples: <strong>{minSamples}</strong>
                    </label>
                    <div className="parameter-info">
                      Minimum number of neighbors required for a point to be considered a core point. Lower values (1-2) allow more points to be clustered. Higher values (4-6) create stricter clustering.
                    </div>
                    <input
                      id="min-samples"
                      type="range"
                      min="1"
                      max="10"
                      value={minSamples}
                      onChange={(e) => setMinSamples(parseInt(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>1 (More points clustered)</span>
                      <span>10 (Stricter clustering)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="membership-threshold">
                      Membership Threshold: <strong>{membershipThreshold.toFixed(2)}</strong>
                    </label>
                    <div className="parameter-info">
                      Minimum probability (0.05-0.5) for an entry to be assigned to a cluster. Lower values allow entries to belong to multiple clusters. Higher values create more exclusive cluster assignments.
                    </div>
                    <input
                      id="membership-threshold"
                      type="range"
                      min="0.05"
                      max="0.5"
                      step="0.05"
                      value={membershipThreshold}
                      onChange={(e) => setMembershipThreshold(parseFloat(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>0.05 (Multi-cluster)</span>
                      <span>0.5 (Exclusive)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="cluster-selection-epsilon">
                      Cluster Selection Epsilon: <strong>{clusterSelectionEpsilon.toFixed(2)}</strong>
                    </label>
                    <div className="parameter-info">
                      Distance threshold for cluster merging. Use 0.0 to disable automatic cluster merging (recommended for fine-grained clusters). Higher values merge nearby clusters.
                    </div>
                    <input
                      id="cluster-selection-epsilon"
                      type="range"
                      min="0.0"
                      max="1.0"
                      step="0.1"
                      value={clusterSelectionEpsilon}
                      onChange={(e) => setClusterSelectionEpsilon(parseFloat(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>0.0 (No merging)</span>
                      <span>1.0 (More merging)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="umap-n-components">
                      UMAP Components: <strong>{umapNComponents}</strong>
                    </label>
                    <div className="parameter-info">
                      Number of dimensions to reduce embeddings to before clustering. Lower values (5-10) preserve more local structure. Higher values (15-30) preserve more global structure. Recommended: 10.
                    </div>
                    <input
                      id="umap-n-components"
                      type="range"
                      min="5"
                      max="30"
                      value={umapNComponents}
                      onChange={(e) => setUmapNComponents(parseInt(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>5 (Local structure)</span>
                      <span>30 (Global structure)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="umap-n-neighbors">
                      UMAP Neighbors: <strong>{umapNNeighbors}</strong>
                    </label>
                    <div className="parameter-info">
                      Number of neighbors to consider for UMAP dimensionality reduction. Lower values (5-10) focus on local structure. Higher values (20-50) focus on global structure. Recommended: 15.
                    </div>
                    <input
                      id="umap-n-neighbors"
                      type="range"
                      min="5"
                      max="50"
                      value={umapNNeighbors}
                      onChange={(e) => setUmapNNeighbors(parseInt(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>5 (Local focus)</span>
                      <span>50 (Global focus)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="umap-min-dist">
                      UMAP Min Distance: <strong>{umapMinDist.toFixed(2)}</strong>
                    </label>
                    <div className="parameter-info">
                      Minimum distance between points in the reduced space. Lower values (0.0-0.1) allow tighter clusters. Higher values (0.3-1.0) spread points apart. Recommended: 0.0 for tight clusters.
                    </div>
                    <input
                      id="umap-min-dist"
                      type="range"
                      min="0.0"
                      max="1.0"
                      step="0.1"
                      value={umapMinDist}
                      onChange={(e) => setUmapMinDist(parseFloat(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>0.0 (Tight clusters)</span>
                      <span>1.0 (Spread apart)</span>
                    </div>
                  </div>
                </div>
            
            <button
              onClick={runClustering}
              disabled={runningClustering}
              className="cluster-run-button"
            >
              {runningClustering ? (
                clusteringTaskStatus === 'PENDING' ? 'Queuing Task...' :
                clusteringTaskStatus === 'STARTED' ? 'Running Clustering...' :
                'Processing...'
              ) : 'Run Clustering'}
            </button>
            
            {runningClustering && clusteringTaskStatus && (
              <div className="task-status-message">
                <p>
                  {clusteringTaskStatus === 'PENDING' && '⏳ Task queued, waiting to start...'}
                  {clusteringTaskStatus === 'STARTED' && '🔄 Clustering in progress. This may take a few minutes...'}
                  {clusteringTaskStatus === 'SUCCESS' && '✅ Clustering completed successfully!'}
                  {clusteringTaskStatus === 'FAILURE' && '❌ Clustering failed. Please try again.'}
                </p>
              </div>
            )}
          </div>
          
            <div className="empty-state">
              <p>No clustering runs available. Run clustering on your entries first.</p>
              </div>
            </div>
          ) : (
            <div className="cluster-layout-container">
              <div className="cluster-run-controls">
                <h3>Run Clustering</h3>
                
                <div className="form-group">
                  <label htmlFor="date-range-type">Time Period:</label>
                  <select
                    id="date-range-type"
                    value={dateRangeType}
                    onChange={(e) => setDateRangeType(e.target.value)}
                  >
                    <option value="all">All Entries</option>
                    <option value="7">Last 7 Days</option>
                    <option value="30">Last 30 Days</option>
                    <option value="90">Last 90 Days</option>
                    <option value="custom">Custom Range</option>
                  </select>
                </div>
                
                {dateRangeType === 'custom' && (
                  <div className="custom-date-range">
                    <div className="form-group">
                      <label htmlFor="start-date">Start Date:</label>
                      <input
                        id="start-date"
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="end-date">End Date:</label>
                      <input
                        id="end-date"
                        type="date"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                      />
                    </div>
                  </div>
                )}
                
                <div className="clustering-parameters">
                  <h4>Clustering Parameters</h4>
                  <p className="parameters-description">
                    Adjust these parameters to fine-tune clustering results. HDBSCAN parameters control cluster formation, while UMAP parameters control dimensionality reduction before clustering.
                  </p>
                  <div className="suggest-settings-row">
                    <button
                      onClick={fetchRecommendedSettings}
                      disabled={recommendLoading}
                      className="suggest-settings-btn"
                    >
                      {recommendLoading ? 'Analyzing…' : '✦ Suggest Settings'}
                    </button>
                    {recommendReasoning && (
                      <p className="recommend-hint">{recommendReasoning}</p>
                    )}
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="min-cluster-size-2">
                      Min Cluster Size: <strong>{minClusterSize}</strong>
                    </label>
                    <div className="parameter-info">
                      Minimum number of entries required to form a cluster. Lower values (2-4) create more fine-grained clusters. Higher values (8-15) create fewer, larger clusters.
                    </div>
                    <input
                      id="min-cluster-size-2"
                      type="range"
                      min="2"
                      max="20"
                      value={minClusterSize}
                      onChange={(e) => setMinClusterSize(parseInt(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>2 (More clusters)</span>
                      <span>20 (Fewer clusters)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="min-samples-2">
                      Min Samples: <strong>{minSamples}</strong>
                    </label>
                    <div className="parameter-info">
                      Minimum number of neighbors required for a point to be considered a core point. Lower values (1-2) allow more points to be clustered. Higher values (4-6) create stricter clustering.
                    </div>
                    <input
                      id="min-samples-2"
                      type="range"
                      min="1"
                      max="10"
                      value={minSamples}
                      onChange={(e) => setMinSamples(parseInt(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>1 (More points clustered)</span>
                      <span>10 (Stricter clustering)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="membership-threshold-2">
                      Membership Threshold: <strong>{membershipThreshold.toFixed(2)}</strong>
                    </label>
                    <div className="parameter-info">
                      Minimum probability (0.05-0.5) for an entry to be assigned to a cluster. Lower values allow entries to belong to multiple clusters. Higher values create more exclusive cluster assignments.
                    </div>
                    <input
                      id="membership-threshold-2"
                      type="range"
                      min="0.05"
                      max="0.5"
                      step="0.05"
                      value={membershipThreshold}
                      onChange={(e) => setMembershipThreshold(parseFloat(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>0.05 (Multi-cluster)</span>
                      <span>0.5 (Exclusive)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="cluster-selection-epsilon-2">
                      Cluster Selection Epsilon: <strong>{clusterSelectionEpsilon.toFixed(2)}</strong>
                    </label>
                    <div className="parameter-info">
                      Distance threshold for cluster merging. Use 0.0 to disable automatic cluster merging (recommended for fine-grained clusters). Higher values merge nearby clusters.
                    </div>
                    <input
                      id="cluster-selection-epsilon-2"
                      type="range"
                      min="0.0"
                      max="1.0"
                      step="0.1"
                      value={clusterSelectionEpsilon}
                      onChange={(e) => setClusterSelectionEpsilon(parseFloat(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>0.0 (No merging)</span>
                      <span>1.0 (More merging)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="umap-n-components-2">
                      UMAP Components: <strong>{umapNComponents}</strong>
                    </label>
                    <div className="parameter-info">
                      Number of dimensions to reduce embeddings to before clustering. Lower values (5-10) preserve more local structure. Higher values (15-30) preserve more global structure. Recommended: 10.
                    </div>
                    <input
                      id="umap-n-components-2"
                      type="range"
                      min="5"
                      max="30"
                      value={umapNComponents}
                      onChange={(e) => setUmapNComponents(parseInt(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>5 (Local structure)</span>
                      <span>30 (Global structure)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="umap-n-neighbors-2">
                      UMAP Neighbors: <strong>{umapNNeighbors}</strong>
                    </label>
                    <div className="parameter-info">
                      Number of neighbors to consider for UMAP dimensionality reduction. Lower values (5-10) focus on local structure. Higher values (20-50) focus on global structure. Recommended: 15.
                    </div>
                    <input
                      id="umap-n-neighbors-2"
                      type="range"
                      min="5"
                      max="50"
                      value={umapNNeighbors}
                      onChange={(e) => setUmapNNeighbors(parseInt(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>5 (Local focus)</span>
                      <span>50 (Global focus)</span>
                    </div>
                  </div>
                  
                  <div className="parameter-group">
                    <label htmlFor="umap-min-dist-2">
                      UMAP Min Distance: <strong>{umapMinDist.toFixed(2)}</strong>
                    </label>
                    <div className="parameter-info">
                      Minimum distance between points in the reduced space. Lower values (0.0-0.1) allow tighter clusters. Higher values (0.3-1.0) spread points apart. Recommended: 0.0 for tight clusters.
                    </div>
                    <input
                      id="umap-min-dist-2"
                      type="range"
                      min="0.0"
                      max="1.0"
                      step="0.1"
                      value={umapMinDist}
                      onChange={(e) => setUmapMinDist(parseFloat(e.target.value))}
                      className="parameter-slider"
                    />
                    <div className="slider-labels">
                      <span>0.0 (Tight clusters)</span>
                      <span>1.0 (Spread apart)</span>
                    </div>
                  </div>
                </div>
                
                <button
                  onClick={runClustering}
                  disabled={runningClustering}
                  className="cluster-run-button"
                >
                  {runningClustering ? (
                    clusteringTaskStatus === 'PENDING' ? 'Queuing Task...' :
                    clusteringTaskStatus === 'STARTED' ? 'Running Clustering...' :
                    'Processing...'
                  ) : 'Run Clustering'}
                </button>
                
                {runningClustering && clusteringTaskStatus && (
                  <div className="task-status-message">
                    <p>
                      {clusteringTaskStatus === 'PENDING' && '⏳ Task queued, waiting to start...'}
                      {clusteringTaskStatus === 'STARTED' && '🔄 Clustering in progress. This may take a few minutes...'}
                      {clusteringTaskStatus === 'SUCCESS' && '✅ Clustering completed successfully!'}
                      {clusteringTaskStatus === 'FAILURE' && '❌ Clustering failed. Please try again.'}
                    </p>
                  </div>
                )}
              </div>
              
              <div className="cluster-visualization-section">
              <div className="cluster-controls">
                <label htmlFor="run-select">Select Clustering Run:</label>
                <select
                  id="run-select"
                  value={selectedRunId || ''}
                  onChange={(e) => setSelectedRunId(parseInt(e.target.value))}
                  className="run-select"
                >
                  {clusteringRuns.map((run) => {
                    const dateRangeStr = run.start_date || run.end_date
                      ? ` (${run.start_date ? new Date(run.start_date).toLocaleDateString() : 'start'} - ${run.end_date ? new Date(run.end_date).toLocaleDateString() : 'end'})`
                      : ''
                    return (
                      <option key={run.id} value={run.id}>
                        {new Date(run.run_timestamp).toLocaleString()} - {run.num_clusters} clusters, {run.num_entries} entries{dateRangeStr}
                      </option>
                    )
                  })}
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
              </div>
            </div>
          )}
        </section>
      )}

      {activeTab === 'therapy' && (
        <section className="therapy-section">

          {/* ── Sidebar ── */}
          <aside className="therapy-sidebar">
            <div className="therapy-sidebar-header">
              <span className="therapy-sidebar-brand">🧠 Reflect AI</span>
              <button
                className="therapy-new-chat-btn"
                onClick={() => {
                  setTherapyConversation([])
                  setTherapyStepsExpanded({})
                  setCurrentConversationId(null)
                }}
                title="New conversation"
                type="button"
              >
                ✏
              </button>
            </div>
            <div className="therapy-sidebar-conversations">
              {historyLoading ? (
                <p className="therapy-sidebar-empty">Loading…</p>
              ) : conversationHistory.length === 0 ? (
                <p className="therapy-sidebar-empty">No conversations yet</p>
              ) : (
                <ul className="therapy-sidebar-list">
                  {conversationHistory.map(conv => (
                    <li key={conv.id}>
                      <button
                        className={`therapy-sidebar-conv-btn${conv.id === currentConversationId ? ' therapy-sidebar-conv-btn--active' : ''}`}
                        onClick={() => loadConversation(conv.id)}
                        type="button"
                      >
                        <span className="therapy-sidebar-conv-title">{conv.title || 'Untitled conversation'}</span>
                        <span className="therapy-sidebar-conv-meta">{new Date(conv.updated_at).toLocaleDateString()}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {/* ── Main chat area ── */}
          <div className="therapy-main">
            <div className="therapy-main-messages">
              {therapyConversation.length === 0 ? (
                <div className="therapy-empty-state">
                  <div className="therapy-empty-icon">🧠</div>
                  <h2>What&rsquo;s on your mind?</h2>
                  <p className="therapy-subtitle">
                    Ask deep, reflective questions about your life. The AI will search your journal
                    entries to provide personalized, grounded insights.
                  </p>
                  <div className="therapy-example-grid">
                    {THERAPY_EXAMPLE_QUESTIONS.map((q, i) => (
                      <button
                        key={i}
                        className="therapy-example-btn"
                        onClick={() => askTherapyQuestion(q)}
                        disabled={therapyLoading}
                      >
                        <span className="example-quote">&ldquo;{q}&rdquo;</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="therapy-conversation">
                  {therapyConversation.map((msg, idx) => (
                    <div key={idx} className={`therapy-message therapy-message--${msg.role}`}>
                      {msg.role === 'user' ? (
                        <div className="therapy-user-bubble">
                          <span className="therapy-role-icon">🙋</span>
                          <p>{msg.content}</p>
                        </div>
                      ) : (
                        <div className={`therapy-assistant-bubble ${msg.isError ? 'therapy-error' : ''}`}>
                          <span className="therapy-role-icon">🧠</span>
                          <div className="therapy-assistant-content">
                            <div className="therapy-answer">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {msg.content}
                              </ReactMarkdown>
                            </div>

                            {msg.steps && msg.steps.length > 0 && (
                              <div className="therapy-research">
                                <button
                                  className="therapy-research-toggle"
                                  onClick={() => toggleTherapySteps(idx)}
                                  type="button"
                                >
                                  {therapyStepsExpanded[idx] ? '▼' : '▶'}&nbsp;
                                  Journal research ({msg.steps.length} {msg.steps.length === 1 ? 'search' : 'searches'})
                                </button>

                                {therapyStepsExpanded[idx] && (
                                  <div className="therapy-steps">
                                    {msg.steps.map((step, si) => (
                                      <div key={si} className="therapy-step">
                                        <div className="therapy-step-header">
                                          <span className="therapy-step-icon">{getToolIcon(step.tool)}</span>
                                          <span className="therapy-step-label">{getToolLabel(step.tool)}</span>
                                          {step.tool_input && Object.keys(step.tool_input).length > 0 && (
                                            <span className="therapy-step-input">
                                              {Object.entries(step.tool_input)
                                                .filter(([k]) => k !== 'dummy')
                                                .map(([k, v]) => `${k}: "${v}"`)
                                                .join(', ')}
                                            </span>
                                          )}
                                        </div>
                                        <div className="therapy-step-observation">
                                          <pre>{step.observation}</pre>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {therapyLoading && (
                    <div className="therapy-message therapy-message--assistant">
                      <div className="therapy-assistant-bubble therapy-thinking">
                        <span className="therapy-role-icon">🧠</span>
                        <div className="therapy-loading-dots">
                          <span>Searching your journals</span>
                          <span className="dot-1">.</span>
                          <span className="dot-2">.</span>
                          <span className="dot-3">.</span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* ── Input area (pinned to bottom) ── */}
            <div className="therapy-input-area">
              {therapyConversation.length > 0 && !therapyLoading && (
                <div className="therapy-suggestion-chips">
                  {THERAPY_EXAMPLE_QUESTIONS.slice(0, 3).map((q, i) => (
                    <button
                      key={i}
                      className="therapy-suggestion-chip"
                      onClick={() => askTherapyQuestion(q)}
                      type="button"
                    >
                      {q.slice(0, 50)}…
                    </button>
                  ))}
                </div>
              )}
              <form
                className="therapy-input-form"
                onSubmit={(e) => { e.preventDefault(); askTherapyQuestion() }}
              >
                <textarea
                  className="therapy-input"
                  value={therapyQuestion}
                  onChange={(e) => setTherapyQuestion(e.target.value)}
                  placeholder="Ask a reflective question about your life, patterns, emotions, or growth..."
                  disabled={therapyLoading}
                  rows={3}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      askTherapyQuestion()
                    }
                  }}
                />
                <div className="therapy-input-actions">
                  <span className="therapy-hint">Enter to send · Shift+Enter for new line</span>
                  <button
                    type="submit"
                    className="therapy-submit-btn"
                    disabled={therapyLoading || !therapyQuestion.trim()}
                  >
                    {therapyLoading ? (
                      <>
                        <span className="therapy-spinner" />
                        Reflecting...
                      </>
                    ) : (
                      '✨ Ask'
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>

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
  const [selectedClusterId, setSelectedClusterId] = useState(null)
  const [clusterPanelOpen, setClusterPanelOpen] = useState(false)
  const [showDetailedClusteringStats, setShowDetailedClusteringStats] = useState(false)
  const [pinnedPoint, setPinnedPoint] = useState(null)
  const isPanningRef = useRef(false)
  const lastPosRef = useRef({ x: 0, y: 0 })
  const transformRef = useRef(transform)
  const zoomAnimationRef = useRef(null)
  transformRef.current = transform

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

  // When a cluster is selected from the legend, zoom to fit that cluster (animated)
  useEffect(() => {
    const ZOOM_DURATION_MS = 150
    const easeOutCubic = (t) => 1 - (1 - t) ** 3

    const applyTarget = (target) => {
      const start = { ...transformRef.current }
      const startTime = performance.now()
      if (zoomAnimationRef.current) cancelAnimationFrame(zoomAnimationRef.current)

      const tick = () => {
        const elapsed = performance.now() - startTime
        const t = Math.min(elapsed / ZOOM_DURATION_MS, 1)
        const eased = easeOutCubic(t)
        setTransform({
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          scale: start.scale + (target.scale - start.scale) * eased
        })
        if (t < 1) zoomAnimationRef.current = requestAnimationFrame(tick)
      }
      zoomAnimationRef.current = requestAnimationFrame(tick)
    }

    if (selectedClusterId === null) {
      applyTarget({ x: 0, y: 0, scale: 1 })
      return () => {
        if (zoomAnimationRef.current) {
          cancelAnimationFrame(zoomAnimationRef.current)
          zoomAnimationRef.current = null
        }
      }
    }
    const padding = 50
    const width = dimensions.width - 2 * padding
    const height = dimensions.height - 2 * padding
    if (width <= 0 || height <= 0) return

    const isInSelectedCluster = (point) => {
      if (point.all_memberships && point.all_memberships.length > 0) {
        const primary = point.all_memberships.find(m => m.is_primary)
        return primary && primary.cluster_id === selectedClusterId
      }
      return point.cluster_id === selectedClusterId
    }
    const clusterPoints = data.points.filter(isInSelectedCluster)
    if (clusterPoints.length === 0) return

    const allX = data.points.map(p => p.x)
    const allY = data.points.map(p => p.y)
    const xMin = Math.min(...allX)
    const xMax = Math.max(...allX)
    const yMin = Math.min(...allY)
    const yMax = Math.max(...allY)
    const xRange = xMax - xMin || 1
    const yRange = yMax - yMin || 1
    const dataCenterX = (xMin + xMax) / 2
    const dataCenterY = (yMin + yMax) / 2
    const baseScale = Math.min(
      (dimensions.width - 2 * padding) / xRange,
      (dimensions.height - 2 * padding) / yRange
    )

    const cMinX = Math.min(...clusterPoints.map(p => p.x))
    const cMaxX = Math.max(...clusterPoints.map(p => p.x))
    const cMinY = Math.min(...clusterPoints.map(p => p.y))
    const cMaxY = Math.max(...clusterPoints.map(p => p.y))
    const crx = cMaxX - cMinX || xRange * 0.1
    const cry = cMaxY - cMinY || yRange * 0.1
    const margin = 1.2
    const scaleFit = Math.min(width / (crx * margin), height / (cry * margin))
    const newScale = Math.min(5, Math.max(0.4, scaleFit / baseScale))
    const cx = (cMinX + cMaxX) / 2
    const cy = (cMinY + cMaxY) / 2
    const target = {
      x: -baseScale * newScale * (cx - dataCenterX),
      y: -baseScale * newScale * (cy - dataCenterY),
      scale: newScale
    }
    applyTarget(target)
    return () => {
      if (zoomAnimationRef.current) {
        cancelAnimationFrame(zoomAnimationRef.current)
        zoomAnimationRef.current = null
      }
    }
  }, [selectedClusterId, data.points, dimensions.width, dimensions.height])

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
    // Put noise (-1) at the end.
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

  // Calculate if a point should be visible/highlighted based on selected cluster
  // Only shows points where the selected cluster is the PRIMARY cluster
  const isPointVisible = (point) => {
    if (selectedClusterId === null) return true
    // Check if the selected cluster is the PRIMARY cluster for this point
    if (point.all_memberships && point.all_memberships.length > 0) {
      const primaryMembership = point.all_memberships.find(m => m.is_primary)
      return primaryMembership && primaryMembership.cluster_id === selectedClusterId
    }
    // Fallback to primary cluster if all_memberships not available
    return point.cluster_id === selectedClusterId
  }

  const tooltipLayout = (() => {
    const activePoint = pinnedPoint || hoveredPoint
    if (!activePoint) return null
    const base = transformPoint(activePoint.x, activePoint.y)
    const tooltipWidth = 280
    // Number of membership rows we actually show (1 when details off, else all)
    const memberships = activePoint.all_memberships || []
    const visibleCount = memberships.length > 0
      ? (showDetailedClusteringStats ? memberships.length : 1)
      : 1
    const baseHeight = 60
    const membershipHeight = 28
    const tooltipHeight = (visibleCount <= 1 ? 44 : baseHeight) + (visibleCount * membershipHeight)
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

    return { x, y, width: tooltipWidth, height: tooltipHeight }
  })()

  const handleMouseDown = (event) => {
    if (event.target.getAttribute?.('data-entry-id') != null) return
    setPinnedPoint(null)
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
      <div className="cluster-viz-main">
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
          const isVisible = isPointVisible(point)
          
          // Calculate opacity: fully hide if filtered out, normal if visible
          let opacity = point.cluster_id === -1 ? 0.3 : 0.8
          if (selectedClusterId !== null && !isVisible) {
            opacity = 0 // Fully hidden when filtered out (only show primary cluster matches)
          }
          
          // Only allow hover if point is visible (or no cluster is selected)
          const isHoverable = selectedClusterId === null || isVisible
          
          return (
            <circle
              key={point.entry_id}
              data-entry-id={point.entry_id}
              cx={pos.x}
              cy={pos.y}
              r={isHovered || pinnedPoint?.entry_id === point.entry_id ? 8 : 5}
              fill={color}
              stroke={isHovered || pinnedPoint?.entry_id === point.entry_id ? '#fff' : 'none'}
              strokeWidth={isHovered || pinnedPoint?.entry_id === point.entry_id ? 2 : 0}
              opacity={opacity}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (!isHoverable) return
                setPinnedPoint(prev => prev?.entry_id === point.entry_id ? null : point)
              }}
              onMouseEnter={() => {
                if (isHoverable) {
                  onPointHover(point)
                }
              }}
              onMouseLeave={() => {
                if (isHoverable) {
                  onPointHover(null)
                }
              }}
              style={{ 
                cursor: isHoverable ? 'pointer' : 'default', 
                transition: 'all 0.2s',
                pointerEvents: opacity === 0 ? 'none' : 'auto'
              }}
            />
          )
        })}
      </svg>

      {(pinnedPoint || hoveredPoint) && tooltipLayout && (() => {
        const activePoint = pinnedPoint || hoveredPoint
        const memberships = activePoint.all_memberships || []
        const visibleCount = memberships.length > 0
          ? (showDetailedClusteringStats ? memberships.length : 1)
          : 1
        const isCompact = visibleCount <= 1
        return (
        <div
          className={`cluster-tooltip ${isCompact ? 'cluster-tooltip--compact' : ''}`}
          style={{
            left: tooltipLayout.x,
            top: tooltipLayout.y,
            width: tooltipLayout.width,
            minHeight: tooltipLayout.height
          }}
        >
          <div className="cluster-tooltip-title">
            {activePoint.title || 'Untitled Entry'}
          </div>
          <div className="cluster-tooltip-body">
            {activePoint.all_memberships && activePoint.all_memberships.length > 0 ? (
              <div className="cluster-memberships-list">
                {(showDetailedClusteringStats
                  ? activePoint.all_memberships
                  : activePoint.all_memberships.filter(m => m.is_primary)
                ).map((membership, idx) => (
                  <div 
                    key={idx} 
                    className={`cluster-membership-tag ${membership.is_primary ? 'primary' : 'secondary'}`}
                  >
                    <span className="membership-indicator">
                      {membership.is_primary ? '★' : '○'}
                    </span>
                    <span className="membership-name">{membership.cluster_name}</span>
                    <span className="membership-probability">
                      {(membership.membership_probability * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="cluster-membership-tag primary">
                <span className="membership-indicator">★</span>
                <span className="membership-name">{activePoint.cluster_name}</span>
                <span className="membership-probability">
                  {(activePoint.membership_probability * 100).toFixed(0)}%
                </span>
              </div>
            )}
          </div>
        </div>
        )
      })()}

      {/* Legend */}
      <div className="cluster-legend">
        <div className="legend-header">
          <h3>Clusters</h3>
          <div className="legend-header-actions">
            <button
              type="button"
              className={`legend-toggle-stats ${showDetailedClusteringStats ? 'active' : ''}`}
              onClick={() => setShowDetailedClusteringStats(s => !s)}
              aria-pressed={showDetailedClusteringStats}
            >
              Show detailed clustering stats
            </button>
            {selectedClusterId !== null && (
              <button
                className="legend-clear-filter"
                onClick={() => { setSelectedClusterId(null); setClusterPanelOpen(false) }}
                type="button"
              >
                Clear Filter
              </button>
            )}
          </div>
        </div>
        <div className="legend-items">
          {data.clusters.map((cluster) => {
            const color = clusterColors[cluster.cluster_id] || '#CCCCCC'
            const name = cluster.topic_label || `Cluster ${cluster.cluster_id}`
            const isSelected = selectedClusterId === cluster.cluster_id
            return (
              <div 
                key={cluster.cluster_id} 
                className={`legend-item ${isSelected ? 'selected' : ''}`}
                onClick={() => {
                  if (isSelected) {
                    setSelectedClusterId(null)
                    setClusterPanelOpen(false)
                  } else {
                    setSelectedClusterId(cluster.cluster_id)
                    setClusterPanelOpen(true)
                  }
                }}
                style={{ cursor: 'pointer' }}
              >
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
            <div 
              className={`legend-item ${selectedClusterId === -1 ? 'selected' : ''}`}
              onClick={() => {
                if (selectedClusterId === -1) {
                  setSelectedClusterId(null)
                  setClusterPanelOpen(false)
                } else {
                  setSelectedClusterId(-1)
                  setClusterPanelOpen(false)
                }
              }}
              style={{ cursor: 'pointer' }}
            >
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

      {/* Cluster Summary Side Panel */}
      <div className={`cluster-summary-sidebar ${clusterPanelOpen && selectedClusterId != null && selectedClusterId !== -1 ? 'open' : ''}`}>
        {clusterPanelOpen && selectedClusterId !== null && selectedClusterId !== -1 && (() => {
          const cluster = data.clusters.find(c => c.cluster_id === selectedClusterId)
          if (!cluster) return null
          const color = clusterColors[selectedClusterId] || '#CCCCCC'
          const name = cluster.topic_label || `Cluster ${selectedClusterId}`
          const entryCount = data.points.filter(p => {
            if (p.all_memberships && p.all_memberships.length > 0) {
              const primary = p.all_memberships.find(m => m.is_primary)
              return primary && primary.cluster_id === selectedClusterId
            }
            return p.cluster_id === selectedClusterId
          }).length
          return (
            <div className="cluster-summary-panel">
              <div className="cluster-summary-header">
                <span className="cluster-summary-color" style={{ backgroundColor: color }} />
                <h3 className="cluster-summary-title">{name}</h3>
                <button
                  className="cluster-summary-close"
                  onClick={() => { setClusterPanelOpen(false); setSelectedClusterId(null) }}
                  type="button"
                  aria-label="Close summary"
                >
                  ×
                </button>
              </div>
              <div className="cluster-summary-stats">
                <span className="cluster-stat">
                  <strong>{entryCount}</strong> entries
                </span>
                {cluster.persistence != null && (
                  <span className="cluster-stat">
                    Stability: <strong>{(cluster.persistence * 100).toFixed(0)}%</strong>
                  </span>
                )}
              </div>
              {cluster.summary ? (
                <div className="cluster-summary-body">
                  <h4>Summary</h4>
                  <p>{cluster.summary}</p>
                </div>
              ) : (
                <div className="cluster-summary-body cluster-summary-empty">
                  <p>No summary available. Re-run clustering with topic generation enabled to generate summaries.</p>
                </div>
              )}
            </div>
          )
        })()}
      </div>
    </div>
  )
}

export default App
