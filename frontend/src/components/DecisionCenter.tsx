
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type {
  JevEvidenceAssessmentResponse,
  JevPathfindingWeights,
  JevProvider,
  JevStatus,
} from '../types';

type DecisionCenterProps = {
  siteName: string;
  siteId: string;
  hasTerrain: boolean;
  availableLayers: string[];
  provider: JevProvider;
  apiKey: string;
  missionPrompt: string;
  decision: JevPathfindingWeights | null;
  applied: boolean;
  loading: boolean;
  error: string;
  notice: string;
  onProviderChange: (provider: JevProvider) => void;
  onApiKeyChange: (apiKey: string) => void;
  onMissionPromptChange: (prompt: string) => void;
  onGenerate: () => void;
  onForgetKey: () => void;
};

export default function DecisionCenter({
  siteName,
  siteId,
  hasTerrain,
  availableLayers,
  provider,
  apiKey,
  missionPrompt,
  decision,
  applied,
  loading,
  error,
  notice,
  onProviderChange,
  onApiKeyChange,
  onMissionPromptChange,
  onGenerate,
  onForgetKey,
}: DecisionCenterProps) {
  const orderedJudgements = decision?.judgements ?? [];

  // Declare all state before deriving values from it.
  const [jevStatus, setJevStatus] = useState<JevStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');

  const [evidenceHypothesis, setEvidenceHypothesis] = useState('');
  const [evidenceTitle, setEvidenceTitle] = useState('');
  const [evidenceSummary, setEvidenceSummary] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  const [evidenceResult, setEvidenceResult] =
    useState<JevEvidenceAssessmentResponse | null>(null);

  const refreshJevStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError('');

    try {
      const result = await api.jevStatus();
      setJevStatus(result);
    } catch (err) {
      setStatusError(
        err instanceof Error
          ? err.message
          : 'Unable to retrieve JEV service status.',
      );
      setJevStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshJevStatus();
  }, [refreshJevStatus]);

  const statusLabel = error
    ? 'SERVICE_ERROR'
    : loading
      ? 'EVALUATING'
      : applied
        ? 'ADAPTIVE_WEIGHTS_APPLIED'
        : !jevStatus
          ? 'STATIC_FALLBACK'
          : !jevStatus.service_url
            ? 'NOT_CONFIGURED'
            : !jevStatus.reachable
              ? 'SERVICE_UNREACHABLE'
              : (!jevStatus.token_configured || jevStatus.reachability?.service_configured === false)
                ? 'AUTH_NOT_CONFIGURED'
                : jevStatus.reachable && (jevStatus.ready || jevStatus.reachability?.service_ready)
                  ? 'SERVICE_READY'
                  : 'STATIC_FALLBACK';

  const statusClass = error
    ? 'is-error'
    : applied
      ? 'is-active'
      : statusLabel === 'SERVICE_READY'
        ? 'is-connected'
        : statusLabel === 'SERVICE_UNREACHABLE' || statusLabel === 'AUTH_NOT_CONFIGURED'
          ? 'is-warning'
          : '';

  const reviewedEvidence = evidenceResult?.results?.[0];

  const stanceLabel = reviewedEvidence?.stance === 'supports'
    ? 'SUPPORTING CANDIDATE'
    : reviewedEvidence?.stance === 'contradicts'
      ? 'COUNTER-EVIDENCE'
      : reviewedEvidence?.stance === 'contextual'
        ? 'CONTEXT ONLY'
        : 'INSUFFICIENT INFORMATION';

  const reviewEvidence = async () => {
    if (
      !apiKey.trim()
      || !missionPrompt.trim()
      || !evidenceHypothesis.trim()
      || !evidenceTitle.trim()
      || !evidenceSummary.trim()
      || !evidenceUrl.trim()
    ) {
      return;
    }

    setEvidenceLoading(true);
    setEvidenceError('');

    try {
      const result = await api.jevEvidenceAssessment({
        provider,
        apiKey,
        objective: missionPrompt,
        hypothesis: evidenceHypothesis,
        evidence: [{
          id: `user-source-${Date.now()}`,
          title: evidenceTitle,
          summary: evidenceSummary,
          url: evidenceUrl,
          mission: siteId,
        }],
      });

      setEvidenceResult(result);
    } catch (err) {
      setEvidenceResult(null);
      setEvidenceError(
        err instanceof Error
          ? err.message
          : 'JEV evidence assessment failed.',
      );
    } finally {
      setEvidenceLoading(false);
    }
  };

  return (
    <div className="jev-content">
      <section className="jev-intro-card">
        <div className="jev-kicker">JEV · DECISION INTELLIGENCE</div>

        <div className="jev-title-row">
          <div>
            <h2>Mission intent → route priorities</h2>
            <p>
              JEV translates your mission objective into a transparent
              preference vector for Route B. Terrain facts and mission
              feasibility remain controlled by MARSCOPE.
            </p>
          </div>

          <span className={`jev-status ${statusClass}`}>
            {statusLabel.replace(/_/g, ' ')}
          </span>
        </div>

        <div className="jev-context-grid">
          <div><span>SELECTED SITE</span><b>{siteName}</b></div>
          <div><span>SITE ID</span><b>{siteId}</b></div>
          <div><span>VERIFIED TERRAIN</span><b>{hasTerrain ? 'AVAILABLE' : 'NOT READY'}</b></div>
          <div><span>AVAILABLE LAYERS</span><b>{availableLayers.length}</b></div>
        </div>

        <p className="jev-layer-list">
          {availableLayers.length
            ? availableLayers.join(' · ').toUpperCase()
            : 'Load a verified site DEM to inspect available terrain layers.'}
        </p>

        <div className="jev-service-status">
          <div className="archive-section-head">
            <b>JEV SERVICE DIAGNOSTICS</b>
            <button
              className="ghost-button"
              onClick={() => void refreshJevStatus()}
              disabled={statusLoading}
            >
              {statusLoading ? 'CHECKING…' : 'REFRESH STATUS'}
            </button>
          </div>

          <div className="jev-context-grid">
            <div>
              <span>SERVICE REACHABILITY</span>
              <b>
                {statusLoading
                  ? 'CHECKING'
                  : jevStatus?.reachable
                    ? jevStatus.reachability.service_ready
                      ? 'REACHABLE · READY'
                      : 'REACHABLE · SERVICE TOKEN MISSING'
                    : 'UNREACHABLE / UNKNOWN'}
              </b>
            </div>

            <div>
              <span>BACKEND CONFIGURATION</span>
              <b>
                {jevStatus
                  ? jevStatus.configured
                    ? 'CONFIGURED'
                    : 'NOT CONFIGURED'
                  : 'UNKNOWN'}
              </b>
            </div>

            <div>
              <span>LAST SUCCESSFUL EVALUATION</span>
              <b>
                {jevStatus?.last_success?.timestamp_utc
                  ? new Date(jevStatus.last_success.timestamp_utc).toLocaleString()
                  : 'NO RECORDED SUCCESS'}
              </b>
            </div>

            <div>
              <span>MODEL / PROVIDER</span>
              <b>
                {jevStatus?.last_success?.available
                  ? `${jevStatus.last_success.model ?? '—'} / ${jevStatus.last_success.provider ?? '—'}`
                  : 'NOT AVAILABLE'}
              </b>
            </div>

            <div>
              <span>CORRELATION ID</span>
              <b>
                {jevStatus?.last_success?.correlation_id
                  ? jevStatus.last_success.correlation_id.slice(0, 8)
                  : '—'}
              </b>
            </div>
          </div>

          <p className="jev-diagnostics-note" style={{ fontSize: '11px', opacity: 0.75, marginTop: '8px' }}>
            Diagnostics reflect service health and local process state. Process history clears on service restart. Health checks do not verify third-party AI provider keys.
          </p>

          {statusError && (
            <div className="jev-message is-error" role="alert">
              Status check failed: {statusError}
            </div>
          )}
        </div>
      </section>

      <section className="jev-config-card">
        <div className="archive-section-head">
          <b>01 / PROVIDER & MISSION INTENT</b>
          <span className="manual-tag">REQUEST-SCOPED KEY</span>
        </div>

        <label className="jev-field">
          <span>JEV PROVIDER</span>
          <select
            value={provider}
            onChange={(event) =>
              onProviderChange(event.target.value as JevProvider)
            }
          >
            <option value="typesafe">TypeSafe · Jev</option>
            <option value="opencode">OpenCode · Jev</option>
          </select>
        </label>

        <label className="jev-field">
          <span>
            {provider === 'opencode'
              ? 'OPENCODE CONSOLE API KEY'
              : 'TYPESAFE API KEY'}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={1024}
            placeholder="Paste key for this session only"
          />
          <small>
            The key is sent in the request body over HTTPS. It is not saved
            to browser storage, a URL, or server environment variables.
          </small>
        </label>

        <label className="jev-field">
          <span>MISSION INTENT <small>{missionPrompt.length}/600</small></span>
          <textarea
            value={missionPrompt}
            onChange={(event) =>
              onMissionPromptChange(event.target.value.slice(0, 600))
            }
            maxLength={600}
            rows={4}
            placeholder="Describe the mission's priorities, trade-offs, target access and operational context..."
          />
        </label>

        <div className="jev-actions">
          <button
            className="primary-button"
            onClick={onGenerate}
            disabled={
              !hasTerrain
              || !apiKey.trim()
              || !missionPrompt.trim()
              || loading
            }
          >
            {loading
              ? 'EVALUATING MISSION…'
              : 'GENERATE WEIGHTS & REPLAN ROUTE B'}
          </button>

          <button
            className="ghost-button"
            onClick={onForgetKey}
            disabled={!apiKey}
          >
            FORGET KEY
          </button>
        </div>

        {error && (
          <div className="jev-message is-error" role="alert">{error}</div>
        )}

        {notice && (
          <div className="jev-message" role="status">{notice}</div>
        )}

        {!hasTerrain && (
          <p className="jev-caveat">
            JEV weighting is disabled until MARSCOPE has a verified DEM
            for the selected site.
          </p>
        )}
      </section>

      <section className="jev-decision-card">
        <div className="archive-section-head">
          <b>02 / DECISION OUTPUT</b>
          <span className={applied ? 'connected-tag' : 'manual-tag'}>
            {applied ? 'ROUTE B UPDATED' : 'NO ADAPTIVE VECTOR'}
          </span>
        </div>

        {decision ? (
          <>
            <div className="jev-model-row">
              <div><span>MODEL</span><b>{decision.model}</b></div>
              <div><span>STRATEGY</span><b>{decision.strategy.replace(/_/g, ' ').toUpperCase()}</b></div>
              <div><span>POLICY</span><b>{decision.policyVersion}</b></div>
            </div>

            <div className="jev-blend">
              <div className="jev-blend-head">
                <span>JEV JUDGEMENT</span>
                <b>{Math.round(decision.jevInfluenceShare * 100)}%</b>
              </div>
              <div className="jev-blend-track">
                <span style={{ width: `${decision.jevInfluenceShare * 100}%` }} />
              </div>

              <div className="jev-blend-head">
                <span>STRATEGY PRIOR</span>
                <b>{Math.round(decision.strategyPriorShare * 100)}%</b>
              </div>
              <div className="jev-blend-track">
                <span style={{ width: `${decision.strategyPriorShare * 100}%` }} />
              </div>
            </div>

            <div className="jev-weight-list">
              {orderedJudgements.map((item) => (
                <div className="jev-weight-row" key={item.objective}>
                  <div>
                    <b>{item.label}</b>
                    <small>
                      Score {item.score.toFixed(1)}/3 · relevance {(item.relevance * 100).toFixed(0)}%
                    </small>
                  </div>

                  <div className="jev-weight-value">
                    {(item.weight * 100).toFixed(1)}%
                  </div>

                  <div className="jev-weight-track">
                    <span style={{ width: `${Math.min(100, item.weight * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>

            <p className="jev-caveat">{decision.notice}</p>
          </>
        ) : (
          <div className="jev-empty-state">
            <b>Static balanced route is in use.</b>
            <p>
              Generate a JEV vector to adapt Route B. Routes A and C remain
              unchanged comparison profiles.
            </p>
          </div>
        )}
      </section>

      <details className="jev-evidence-review">
        <summary>
          <span className="data-group-index">03</span>
          <span>
            <b>NASA EVIDENCE TRIAGE</b>
            <small>Assess a source record against the mission hypothesis</small>
          </span>
        </summary>

        <div className="jev-evidence-body">
          <p className="jev-caveat">
            Paste the metadata and summary from an official NASA/PDS source.
            JEV assesses the supplied text only; it does not fetch or verify
            the linked record.
          </p>

          <label className="jev-field">
            <span>HYPOTHESIS TO REVIEW</span>
            <textarea
              value={evidenceHypothesis}
              onChange={(event) => setEvidenceHypothesis(event.target.value.slice(0, 700))}
              maxLength={700}
              rows={3}
              placeholder="State the specific scientific hypothesis this observation may support or contradict."
            />
          </label>

          <label className="jev-field">
            <span>NASA SOURCE TITLE</span>
            <input
              value={evidenceTitle}
              onChange={(event) => setEvidenceTitle(event.target.value.slice(0, 300))}
              maxLength={300}
              placeholder="Exact product or observation title"
            />
          </label>

          <label className="jev-field">
            <span>OFFICIAL SOURCE URL</span>
            <input
              type="url"
              value={evidenceUrl}
              onChange={(event) => setEvidenceUrl(event.target.value.slice(0, 2000))}
              maxLength={2000}
              placeholder="https://..."
            />
          </label>

          <label className="jev-field">
            <span>SUPPLIED SOURCE SUMMARY</span>
            <textarea
              value={evidenceSummary}
              onChange={(event) => setEvidenceSummary(event.target.value.slice(0, 1800))}
              maxLength={1800}
              rows={4}
              placeholder="Paste the abstract, observation summary or relevant metadata excerpt."
            />
          </label>

          <div className="jev-actions">
            <button
              className="primary-button"
              onClick={() => void reviewEvidence()}
              disabled={
                !apiKey.trim()
                || !evidenceHypothesis.trim()
                || !evidenceTitle.trim()
                || !evidenceSummary.trim()
                || !evidenceUrl.trim()
                || evidenceLoading
              }
            >
              {evidenceLoading ? 'REVIEWING SOURCE…' : 'ASSESS NASA EVIDENCE'}
            </button>
          </div>

          {evidenceError && (
            <div className="jev-message is-error" role="alert">
              {evidenceError}
            </div>
          )}

          {reviewedEvidence && (
            <div className="jev-evidence-result">
              <div className="jev-evidence-result-head">
                <b>{stanceLabel}</b>
                <span>
                  {(reviewedEvidence.stanceConfidence * 100).toFixed(0)}% stance confidence
                </span>
              </div>

              <div className="jev-evidence-metrics">
                <div>
                  <span>RELEVANCE</span>
                  <b>{reviewedEvidence.relevanceScore.toFixed(1)} / 3</b>
                </div>
                <div>
                  <span>DIRECT SUPPORT</span>
                  <b>{(reviewedEvidence.directSupportProbability * 100).toFixed(0)}%</b>
                </div>
                <div>
                  <span>NOVELTY</span>
                  <b>{reviewedEvidence.noveltyScore.toFixed(1)} / 3</b>
                </div>
              </div>

              <p>{evidenceResult?.notice}</p>
              <a href={reviewedEvidence.source.url} target="_blank" rel="noreferrer">
                Open supplied source record
              </a>
            </div>
          )}
        </div>
      </details>

      <section className="jev-safety-note">
        <b>DETERMINISTIC SAFETY BOUNDARY</b>
        <p>
          JEV weights influence preference ranking only. Slope, obstacle,
          nodata, energy, oxygen, EVA-time, temperature and return-reserve
          checks remain deterministic planner constraints. JEV cannot make
          an infeasible route feasible or declare a route safe.
        </p>
        <p>
          These weights are not probabilities of safety or route success.
          If the JEV service fails, MARSCOPE clears the adaptive vector and
          plans with its static balanced profile.
        </p>
      </section>
    </div>
  );
}
