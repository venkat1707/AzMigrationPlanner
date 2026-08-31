import { AlertTriangle, Boxes, Calculator, CalendarRange, Database, GitBranch, Layers3, ListChecks, Repeat, Save, Server, Shuffle } from 'lucide-react'

export default function WavePlannerGuide() {
  return <div className="page doc-page">
    <article className="doc-article">
      <header className="doc-hero">
        <span className="eyebrow">Documentation</span>
        <h1>How the migration wave planner works</h1>
        <p>A plain-English guide to what the Wave Planning screen does, every option you can change, and which options to use for common situations. No coding or database knowledge required.</p>
      </header>

      <section className="doc-section" aria-labelledby="doc-what">
        <h2 id="doc-what"><CalendarRange size={18} /> What the wave planner actually does</h2>
        <p>The wave planner looks at every server you have assessed and works out a sensible order to migrate them in. It groups servers into <strong>Sprints</strong> (small batches you migrate together, usually over a weekend or a change window), and groups sprints into <strong>Waves</strong> (usually one wave per environment, such as Dev, Test, or Production).</p>
        <p>Its number one goal is to keep servers that talk to each other in the <em>same</em> sprint, so you don't migrate half of a working system and leave the other half behind, waiting, and broken. Everything else &mdash; sprint size, environment order, data-heavy separation &mdash; is a rule you can bend to fit how your organization wants to run the migration.</p>
      </section>

      <section className="doc-section" aria-labelledby="doc-glossary">
        <h2 id="doc-glossary"><ListChecks size={18} /> Key terms, in plain English</h2>
        <dl className="doc-glossary">
          <div><dt>Wave</dt><dd>A large phase of the migration, almost always one per environment (for example, "Dev migration wave"). A wave contains one or more sprints.</dd></div>
          <div><dt>Sprint</dt><dd>A small batch of servers you migrate together in one change window. This is the unit you actually schedule and execute against.</dd></div>
          <div><dt>Readiness</dt><dd>Comes from your Server Assessment data. Only servers marked "Ready" or "Ready with conditions" are planned; anything else is set aside as <strong>deferred</strong> so it doesn't block the rest of the plan.</dd></div>
          <div><dt>Data-heavy server</dt><dd>Any database server, or any server whose assessed storage is above a size you choose (2048 GB by default). These are flagged because moving a lot of data is slower and riskier, so you may want to spread them out.</dd></div>
          <div><dt>Affinity group</dt><dd>A list of applications or servers you tell the planner must always land in the same sprint, no matter what else the automatic logic would decide.</dd></div>
          <div><dt>Co-hosted applications</dt><dd>Two or more applications that share at least one server (for example, a shared file server or monitoring agent). The planner always keeps their sprints merged into one, ahead of your size guardrails &mdash; see "Co-hosted applications" below.</dd></div>
          <div><dt>Cross-sprint dependency</dt><dd>Two servers that talk to each other but ended up in different sprints. Not necessarily a mistake, but worth reviewing &mdash; especially if the "downstream" side is scheduled after the "upstream" side.</dd></div>
          <div><dt>Severe warning</dt><dd>A special case of the above: a database and the application that uses it are split across two different <em>waves</em>. This is called out separately because it's the riskiest kind of split.</dd></div>
        </dl>
      </section>

      <section className="doc-section" aria-labelledby="doc-steps">
        <h2 id="doc-steps"><Layers3 size={18} /> The order the planner thinks in</h2>
        <p>Every time you click "Generate migration plan", the planner works through the same steps, in this order. Later steps never undo an earlier hard rule &mdash; for example, it will never merge two different environments together just to hit a minimum sprint size.</p>
        <ol className="doc-steps">
          <li><strong>Pick the servers in scope.</strong> Starts from every assessed server, then keeps only the ones matching your chosen environments and treatment plans, and drops any server or application you explicitly excluded.</li>
          <li><strong>Sort by readiness.</strong> Servers that are "Ready" or "Ready with conditions" continue into planning. Anything else is set aside as deferred and shown separately &mdash; it does not stop the rest of the plan from being built.</li>
          <li><strong>Find natural groups.</strong> Servers are clustered by observed network dependencies (who talks to whom) and by application, so a working system's pieces stay together &mdash; see "The math behind sprint sizing" below for exactly how this clustering works.</li>
          <li><strong>Order the environments.</strong> Decides which environment's wave comes first (for example, Dev before Test before Production), unless you've turned environment separation off.</li>
          <li><strong>Pack sprints.</strong> Fits the groups from step 3 into sprints, respecting your size guardrails (or an automatic size, if you've turned that on) and, if enabled, keeping data-heavy workloads apart.</li>
          <li><strong>Merge co-hosted applications.</strong> Applications that share a server always end up in one combined sprint, even if that goes over your maximum &mdash; then any unrelated application dragged along by that merge is relocated back out to relieve the overflow. See "Co-hosted applications" below.</li>
          <li><strong>Tidy up and report.</strong> Merges any sprint that came out too small if it safely can, then reports any dependency that still ended up crossing a sprint or wave boundary as a warning for you to review.</li>
        </ol>
      </section>

      <section className="doc-section" aria-labelledby="doc-scope">
        <h2 id="doc-scope"><Boxes size={18} /> Choosing what's in scope</h2>
        <h3>Planning scope: environments and treatment plans</h3>
        <p>Before anything else, you choose which environments and which application "treatment plans" are eligible for this plan. <strong>This is the setting people forget most often:</strong> by default, only applications with the treatment plan "Rehost" are included. If you haven't set a treatment plan for an application yet, it's treated as Rehost automatically &mdash; but if you've deliberately marked something "Retire" or "Retain", it will not appear in the wave plan unless you tick its box here too.</p>
        <div className="doc-example">
          <strong>Example</strong>
          <p>You have 300 servers. 40 belong to an application marked "Retire" because it's being shut down, not moved. If you leave the default "Rehost only" filter in place, those 40 servers simply never show up in the plan &mdash; which is usually exactly what you want.</p>
        </div>
        <h3>Plan exclusions</h3>
        <p>Type in exact application or server names to leave them out of this particular plan run, even if they'd otherwise qualify. Excluding an application removes every one of its servers.</p>
        <div className="doc-example">
          <strong>Example</strong>
          <p>A finance application is frozen for a compliance audit this quarter. Add its name under "Applications to exclude" and it's left out of every future plan generation until you remove it &mdash; without you having to change its treatment plan.</p>
        </div>
      </section>

      <section className="doc-section" aria-labelledby="doc-sizing">
        <h2 id="doc-sizing"><Shuffle size={18} /> Controlling sprint size</h2>
        <h3>Minimum / maximum servers per sprint</h3>
        <p>The two plain number boxes. The planner tries to keep every sprint between these two sizes. It will merge undersized sprints together where it safely can, and it will never build a sprint bigger than the maximum unless a single dependency group is simply larger than that on its own (in which case it explains why in that sprint's notes).</p>
        <h3>"Let the tool determine the optimal sprint size" (automatic sizing)</h3>
        <p>Turning this on ignores the min/max boxes completely. Instead, the planner groups servers purely by how tightly they're connected, and only splits a group when it would otherwise become an impractically large single change window. Every application's own servers always stay together in one sprint in this mode, even if that group ends up larger than what a fixed guardrail would normally allow.</p>
        <h3>"Zero cross-sprint dependency"</h3>
        <p>Only available with automatic sizing turned on. This removes the safety cap entirely for anything that is connected by an observed dependency: no two servers that talk to each other will ever be split across sprints, full stop, even if that means one sprint becomes very large. Use this when a missed dependency would be more painful than an oversized change window.</p>
        <div className="doc-example">
          <strong>Example</strong>
          <p>Your web tier, app tier, and database for one system all depend on each other and add up to 45 servers. With a 20-server maximum, that group would normally be split and flagged as an exception. With automatic sizing and zero cross-sprint dependency both on, all 45 stay in a single sprint instead.</p>
        </div>
      </section>

      <section className="doc-section" aria-labelledby="doc-math">
        <h2 id="doc-math"><Calculator size={18} /> The math behind sprint sizing, in simple English</h2>
        <p>This section goes one level deeper than the settings above and explains the actual arithmetic and step-by-step process the planner runs every time you click "Generate migration plan" &mdash; with a worked example for each piece.</p>

        <h3><GitBranch size={18} /> Step 1: turning "who talks to whom" into a graph</h3>
        <p>Before any sprint is created, the planner builds an invisible map (a graph) of every server in scope. Each server is a dot; every observed connection between two servers becomes a line (an "edge") joining two dots. If two servers exchanged traffic on more than one port, all of those connections are added together into a single edge <strong>weight</strong> &mdash; a bigger number means a stronger, more important connection to keep together.</p>
        <div className="doc-example">
          <strong>Example</strong>
          <p>Server <code>App01</code> connects to database server <code>Db01</code> 400 times a day (a strong edge, weight 400) and to a logging server <code>Log01</code> only 3 times a day (a weak edge, weight 3). If a choice ever has to be made about which connection to keep together in one sprint, <code>App01</code>&ndash;<code>Db01</code> wins every time, because a bigger weight always beats a smaller one.</p>
        </div>

        <h3><Boxes size={18} /> Step 2: the safety ceiling &mdash; how big a cluster is allowed to get</h3>
        <p>The ceiling-and-edge-trimming logic in this step and the next only runs when <strong>"Let the tool determine the optimal sprint size"</strong> (automatic sizing) is turned on &mdash; that's precisely the calculation it's doing for you instead of asking for a fixed minimum/maximum. With automatic sizing on, the planner works out a maximum practical cluster size for the group of servers it's currently looking at (for example, all of Production's application servers). This is called the <strong>safety ceiling</strong>, and the formula is:</p>
        <div className="doc-example">
          <strong>Safety ceiling formula</strong>
          <p><code>ceiling = clamp(round(group size × 20%), minimum 25, maximum 60)</code></p>
          <p>In other words: take 20% of how many servers are in that group, round it to the nearest whole server, then make sure it's never lower than 25 and never higher than 60.</p>
        </div>
        <ul className="doc-plain-list">
          <li>A group of <strong>50 servers</strong>: 20% is 10, but the floor of 25 applies, so the ceiling is <strong>25</strong>.</li>
          <li>A group of <strong>150 servers</strong>: 20% is 30, which is already between the floor and cap, so the ceiling is <strong>30</strong>.</li>
          <li>A group of <strong>500 servers</strong>: 20% is 100, but the cap of 60 applies, so the ceiling is <strong>60</strong>.</li>
        </ul>
        <p>This ceiling only limits how large a single dependency-connected cluster is allowed to grow before the planner is willing to cut a weak connection to keep it manageable. If automatic sizing is off, this formula isn't used at all &mdash; clusters are instead simply each application's own servers (plus anything you explicitly forced together with affinity groups), split to fit your fixed maximum servers box using straightforward first-fit packing; cross-application dependencies in that mode are handled later, by the refinement loop described in Step 4.</p>

        <h3><GitBranch size={18} /> Step 3: building clusters, and how weaker edges get left out (automatic sizing only)</h3>
        <p>With the graph and the ceiling ready, the planner builds clusters (groups of servers that will end up in the same sprint) using this priority order, every time:</p>
        <ol className="doc-steps">
          <li><strong>Explicit affinity groups merge first, unconditionally.</strong> If you listed two applications or servers under "same sprint" affinity, they are joined immediately, no matter how large the resulting group becomes.</li>
          <li><strong>An application's own servers always merge together</strong> (in automatic sizing mode) before anything else is considered, so one application is never split by accident.</li>
          <li><strong>Remaining dependency edges are sorted, strongest first</strong> &mdash; and any edge touching a database server is tried before non-database edges of the same or even higher weight, so a database connection is always the last kind of link to be cut, not the first.</li>
          <li><strong>Each edge, from strongest to weakest, is merged into a cluster only if doing so would not push that cluster's size past the safety ceiling.</strong> The moment merging an edge would break the ceiling, that edge is skipped and left out &mdash; the two servers on either end of it stay in separate clusters (and, most likely, separate sprints), which is what shows up afterward as a "cross-sprint dependency" for you to review.</li>
        </ol>
        <div className="doc-example">
          <strong>Worked example</strong>
          <p>Imagine a group of application servers with a safety ceiling of 25, and one dependency cluster forming around a popular internal API: <code>Api01</code> (already merged with 22 other servers, for a running total of 23) has two remaining candidate edges: one to <code>Reports01</code> with weight 50, and one to <code>Adhoc01</code> with weight 4. The planner tries the stronger edge first: merging <code>Reports01</code> would bring the cluster to 24 servers &mdash; still under the ceiling of 25, so it merges. It then tries <code>Adhoc01</code>: merging it would bring the cluster to 25 servers... which is exactly at the ceiling, so it still fits and also merges, reaching exactly 25. If a third candidate, <code>Rare01</code> (weight 2), had also been waiting, merging it would have pushed the cluster to 26 &mdash; over the ceiling &mdash; so that edge is the one left out. <code>Rare01</code> stays in its own smaller cluster, and its connection to the big cluster is reported afterward as a cross-sprint dependency, precisely because it was the single weakest (least critical) remaining edge at the moment the ceiling was reached.</p>
        </div>
        <p>Turning on <strong>Zero cross-sprint dependency</strong> (automatic sizing only) simply removes step 4's ceiling check for these edges entirely &mdash; every dependency-connected pair is merged regardless of size, so no edge is ever left out on purpose.</p>

        <h3><Repeat size={18} /> Step 4: how many passes the planner makes before finalizing sprints</h3>
        <p>What happens next depends on whether automatic sizing is on:</p>
        <ul className="doc-plain-list">
          <li><strong>Automatic sizing on</strong>: any cluster that already reached the safety ceiling (or is naturally that large) becomes its own sprint immediately, in a single pass. Smaller, independent clusters (ones with no dependency on anything else) are then packed together &mdash; largest first &mdash; into the same sprint up to the ceiling, purely to avoid ending up with lots of tiny sprints. Since these clusters have no dependency between them either way, combining them costs nothing. This whole process runs once per environment and per pool (shared infrastructure servers are always packed completely separately from application servers).</li>
          <li><strong>Automatic sizing off (fixed min/max)</strong>: clusters are first packed into sprints using the same "largest first" approach, respecting your minimum/maximum boxes. Then the planner runs a <strong>refinement loop</strong> to squeeze out any dependency it can still improve: on every pass, it looks at every possible way to move one group of servers from one sprint to another, and every possible way to swap one group between two sprints, and calculates the "gain" (how much cross-sprint dependency weight that move would remove). It applies only the single best move it found, then repeats the whole scan from scratch. This loop runs for <strong>up to 250 passes</strong>, but almost always stops much sooner than that, because it stops immediately once a full scan finds no move left that would improve anything &mdash; 250 is simply a safety limit so the calculation can never run forever on an unusually large or tangled estate. A final tidy-up pass then merges or borrows servers for any sprint that still ended up below your minimum size.</li>
        </ul>
        <div className="doc-example">
          <strong>Example</strong>
          <p>Suppose after the initial packing, Sprint 2 and Sprint 5 each hold a small group of servers, and it turns out those two groups actually depend heavily on each other. Pass 1 of the refinement loop scans everything, finds that swapping these two groups would remove more cross-sprint dependency weight than any other possible move, and makes that one swap. Pass 2 scans again from scratch (now that the layout has changed) and finds a smaller, second improvement elsewhere, and makes it. Pass 3 finds no further improving move anywhere, so the loop stops after 3 passes &mdash; nowhere near the 250-pass safety limit.</p>
        </div>

        <h3 id="doc-cohosted"><Layers3 size={18} /> Step 5: co-hosted applications, and relieving any overflow they cause</h3>
        <p>Two applications are <strong>co-hosted</strong> when they share at least one server &mdash; for example, both point at the same shared file server, or both have the same monitoring agent installed. This is checked once, right after sprints are packed (and, in fixed min/max mode, after the refinement loop above has finished). Every sprint that ends up holding a piece of a co-hosted server group is combined into a single sprint, regardless of your minimum/maximum boxes or the automatic ceiling &mdash; splitting a shared server across two different change windows is treated as riskier than a temporarily oversized sprint.</p>
        <p>If that merge pushes the combined sprint above its size limit, the planner immediately works to relieve the overflow, one whole application at a time (an application's own servers are never split up to do this): it looks at every <em>other</em> application riding along in that sprint that has no real reason to be there &mdash; anything except the applications that actually share the server &mdash; ranks them by how weakly connected they are to the rest of the sprint, and relocates the weakest one to another same-environment sprint with spare room, or a brand-new sprint if nothing fits. This repeats until the sprint is back within its limit. Only if every unrelated application has already been moved out and the sprint is still oversized will one of the actual co-hosted applications be relocated as a last resort, purely so the size limit is still honored &mdash; this is intentionally rare.</p>
        <div className="doc-example">
          <strong>Example</strong>
          <p>Billing, Reporting, and Payroll all point to the same shared file server, so their sprints are merged into one. That merge also happens to combine an unrelated application, Intranet, that was previously packed alongside Reporting purely by chance. If the merged sprint now exceeds your 20-server maximum, the planner relocates Intranet out to a sprint with room (or a new one) &mdash; Billing, Reporting, and Payroll themselves are never separated, since they're the reason the sprints had to merge in the first place.</p>
        </div>
        <p>These merges and relocations happen automatically and are not listed sprint-by-sprint in the plan output &mdash; what you see is already the final result, and every sprint you see still respects your configured maximum (or the automatic ceiling) because of this step.</p>
      </section>

      <section className="doc-section" aria-labelledby="doc-environments">
        <h2 id="doc-environments"><Layers3 size={18} /> Environments</h2>
        <h3>Separate environments</h3>
        <p>On by default. Keeps servers from different environments (Dev, Test, Production, and so on) in separate waves and sprints, so you never accidentally migrate a Dev server and a Production server together. Turning this off treats your entire estate as one undivided pool.</p>
        <h3>Prioritize environments + environment order</h3>
        <p>When environment separation is on, this decides which environment's wave is scheduled first. Type your preferred order (for example <code>Dev, Test, UAT, Pre-prod, Prod</code>) and the planner sequences waves to match, putting anything not listed at the end in alphabetical order.</p>
        <div className="doc-example">
          <strong>Example</strong>
          <p>Your organization always wants to prove a migration approach in Dev and Test before touching anything customer-facing. Set the order to <code>Dev, Test, UAT, Pre-prod, Prod</code> and Production is always the last wave generated, regardless of server counts.</p>
        </div>
      </section>

      <section className="doc-section" aria-labelledby="doc-data-heavy">
        <h2 id="doc-data-heavy"><Database size={18} /> Data-heavy workloads</h2>
        <p>"Data-heavy" means either a database server, or any server whose assessed storage is at or above a threshold you set (2048 GB by default). By default this label is purely informational and does not change grouping. Turn on "Separate data-heavy workloads" to actively limit each sprint to at most one data-heavy server &mdash; useful when large data transfers are your main scheduling risk, since it spreads that risk across more, smaller change windows instead of stacking several big transfers into one weekend.</p>
      </section>

      <section className="doc-section" aria-labelledby="doc-affinity">
        <h2 id="doc-affinity"><Boxes size={18} /> Forcing groups together with affinity</h2>
        <p>Sometimes two applications must move in the same weekend even though the tool has no recorded network dependency between them &mdash; for example, a shared business process, a manual data sync, or an organizational deadline. List them under "Applications in the same sprint" or "Servers in the same sprint" and the planner merges them unconditionally, ahead of every other rule except hard environment boundaries.</p>
        <div className="doc-example">
          <strong>Example</strong>
          <p>Order Processing and Invoicing don't talk to each other over the network, but the business runs a manual month-end reconciliation between them and wants both systems on the same platform at the same time. Add <code>Order Processing, Invoicing</code> as one line under application affinity groups, and every server for both applications will always land in the same sprint.</p>
        </div>
      </section>

      <section className="doc-section" aria-labelledby="doc-worked-example">
        <h2 id="doc-worked-example"><Server size={18} /> A complete worked example</h2>
        <p>Say your Production environment has three small systems, all marked "Ready" and "Rehost":</p>
        <ul className="doc-plain-list">
          <li><strong>Billing</strong>: 1 web server, 1 app server, 1 database server (the database is 3,000 GB, so it's data-heavy).</li>
          <li><strong>Reporting</strong>: 1 app server that reads from the Billing database every night (an observed dependency).</li>
          <li><strong>Intranet</strong>: 2 web servers with no dependency on anything else.</li>
        </ul>
        <p>With default settings (minimum 5, maximum 20, environments separated, data-heavy separation off), the planner sees that Reporting depends on Billing's database, so it keeps Billing and Reporting together &mdash; four servers. Intranet has no connections to either, so it can be packed alongside them to help reach the 5-server minimum, giving you one Production sprint of six servers.</p>
        <p>Now turn on "Separate data-heavy workloads". The Billing database is data-heavy, and the plan will avoid placing a second data-heavy server in that same sprint &mdash; in this example there isn't a second one, so the grouping looks the same, but in a larger estate this is exactly what keeps two big database migrations from landing in the same weekend.</p>
        <p>Now suppose Intranet actually belongs to a different team that wants to migrate on a separate schedule. Add <code>Intranet</code> under "Applications to exclude" for this run, generate the plan, and it disappears from the output entirely &mdash; run a second, separate plan for it later using "Add newly eligible workloads" (see Saving your plan, below).</p>
      </section>

      <section className="doc-section" aria-labelledby="doc-scenarios">
        <h2 id="doc-scenarios"><ListChecks size={18} /> Common scenarios and what to turn on</h2>
        <div className="doc-scenario-grid">
          <article className="doc-scenario-card">
            <h3>"I just want a sensible plan without tuning anything"</h3>
            <p>Leave every setting at its default. Environments stay separate, Dev-to-Prod ordering is applied, sprints target 5&ndash;20 servers, and only Rehost applications are included.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"I don't want to think about sprint sizing at all"</h3>
            <p>Turn on <strong>Let the tool determine the optimal sprint size</strong>. Sprint sizes are then derived purely from how servers are connected, not from a fixed number you have to guess up front.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"A missed dependency would be a disaster for us"</h3>
            <p>Turn on automatic sizing, then also turn on <strong>Zero cross-sprint dependency</strong>. No connected pair of servers can ever be split across sprints, even if a sprint grows large as a result.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"We must prove it in lower environments first"</h3>
            <p>Keep <strong>Separate environments</strong> and <strong>Prioritize environments</strong> on, and set the environment order to put Dev and Test ahead of Production.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"Our big database migrations are the risky part"</h3>
            <p>Turn on <strong>Separate data-heavy workloads</strong> so no sprint ever contains more than one large data transfer at a time.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"Two applications have no technical link but must move together"</h3>
            <p>List them together under <strong>Suggested sprint affinity</strong>. This is the only setting that overrides the planner's automatic grouping logic.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"I want to test an idea without losing my saved plan"</h3>
            <p>Generate a new plan and review it &mdash; nothing is saved to the workspace until you explicitly click <strong>Save plan</strong>. You can discard an unsaved, regenerated plan and instantly return to the last saved version.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"A new batch of servers just became ready"</h3>
            <p>Widen your scope filters (or clear an exclusion) and generate again. If only new servers were added, saving offers <strong>Add newly eligible workloads</strong>, which appends new sprints without touching anything already planned or any task already assigned.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"An application we already planned is now on hold"</h3>
            <p>Retire it or add it to the exclusion list, then generate again. Because scope narrowed, saving will offer to <strong>replace</strong> the current plan, which resets task assignments &mdash; see the warning below before confirming this.</p>
          </article>
        </div>
      </section>

      <section className="doc-section" aria-labelledby="doc-saving">
        <h2 id="doc-saving"><Save size={18} /> Saving your plan</h2>
        <p>Generating a plan never changes anything by itself &mdash; it's a preview. There are three ways a save can behave:</p>
        <ul className="doc-plain-list">
          <li><strong>Initial save</strong>: no plan was saved before, so this simply becomes the saved plan.</li>
          <li><strong>Add newly eligible workloads</strong>: your new scope is a superset of what was already planned (for example, you widened a filter or new servers became ready). Only the newly added servers get new sprints; every existing sprint, task, comment, and status is left untouched.</li>
          <li><strong>Replace the saved plan</strong>: your new scope removed something, or you changed a planning rule that affects existing groupings. This overwrites the saved plan, and clears every task assignment, status, comment, and the task history log, because those may no longer make sense against the new grouping.</li>
        </ul>
        <div className="doc-warning">
          <AlertTriangle size={16} />
          <p><strong>Replacing a plan deletes task history.</strong> Because this permanently erases task and comment history, only a user with <strong>Delete</strong> privilege (or an administrator) can confirm a replace. A user with only Modify access can still generate and review plans, and can save using "Add newly eligible workloads", but will see the replace option disabled with an explanation.</p>
        </div>
      </section>

      <section className="doc-section" aria-labelledby="doc-warnings">
        <h2 id="doc-warnings"><AlertTriangle size={18} /> Reading the warnings</h2>
        <ul className="doc-plain-list">
          <li><strong>Deferred servers</strong>: not included in any sprint because their assessed readiness isn't "Ready" or "Ready with conditions". Fix the underlying readiness data and regenerate to bring them into scope.</li>
          <li><strong>Excluded servers</strong>: left out on purpose, because you excluded the server or its application, or because its treatment plan wasn't selected in the planning scope.</li>
          <li><strong>Cross-sprint dependency</strong>: two servers that depend on each other ended up in different sprints. Flagged as "scheduled later" when the depended-on server is planned after the server that needs it &mdash; worth double-checking before you commit to the schedule.</li>
          <li><strong>Severe warning</strong>: a database and one of its consuming applications are split across two different <em>waves</em> (not just sprints), which is the highest-risk version of the above and is called out on every affected wave.</li>
          <li><strong>Co-hosted application merges</strong>: when applications sharing a server get merged into one sprint (and any overflow relocated back out to relieve it &mdash; see "Co-hosted applications" above), this happens silently. It isn't listed sprint-by-sprint, so every sprint you see already reflects the final, correctly-sized outcome.</li>
        </ul>
      </section>
    </article>
  </div>
}
