import { AlertTriangle, Boxes, Database, Download, FileCode2, GitMerge, Layers3, ListChecks, Network, Shield, Waypoints } from 'lucide-react'

export default function FirewallRulesGuide() {
  return <div className="page doc-page">
    <article className="doc-article">
      <header className="doc-hero">
        <span className="eyebrow">Documentation</span>
        <h1>How firewall rules are generated</h1>
        <p>A plain-English guide to the Firewall Rules page: how it turns observed server-to-server traffic into Azure NSG, Azure Firewall, and on-prem firewall rules, and what to do with the Terraform and Bicep scripts you can download.</p>
      </header>

      <section className="doc-section" aria-labelledby="fw-doc-what">
        <h2 id="fw-doc-what"><Shield size={18} /> What this page does, in plain English</h2>
        <p>Think of this page as a translator. Somewhere in your network, tools have already recorded which servers actually talk to which other servers, on which ports, over the last few months. This page takes that raw, messy list of "who talked to whom" and turns it into a tidy, ready-to-review set of firewall allow rules, written from whichever point of view you pick: <strong>Azure NSG</strong>, <strong>Azure Firewall</strong>, or <strong>On-prem Firewall</strong>.</p>
        <p>You choose a <strong>scope</strong> (one sprint's worth of servers, or every sprint at once) and whether to hide connections to shared "core infrastructure" servers (domain controllers, monitoring, backup, etc.) that almost every server talks to and would otherwise clutter the list. Everything else &mdash; the actual rules, their direction, their addresses &mdash; is worked out automatically from the data described below.</p>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-sources">
        <h2 id="fw-doc-sources"><Layers3 size={18} /> Where the information comes from</h2>
        <p>Nothing on this page is guessed or invented. Every rule is built by combining several datasets you've already uploaded or configured elsewhere in this application:</p>
        <ul className="doc-plain-list">
          <li><strong>Dependency discovery data</strong> (the Dependency Export files, or Splunk/Corelight imports) &mdash; this is the actual record of "server A connected to server B on port X, this many times." It's the foundation for every rule: without a recorded connection, no rule is created for it.</li>
          <li><strong>Server assessment data</strong> &mdash; gives the current on-prem IP address for each server, used whenever a connection record itself doesn't already carry an IP.</li>
          <li><strong>Core infrastructure list</strong> (servers, IPs, and load balancer IPs) &mdash; used to recognize and, if you choose, hide shared-service traffic.</li>
          <li><strong>Office and VPN network ranges</strong> (configured on the Core Infrastructure page) &mdash; the CIDR ranges for your corporate office and VPN networks, used to recognize traffic coming from end-user devices rather than other servers.</li>
          <li><strong>Windows Services / Ports catalog</strong> &mdash; a lookup table that turns a bare port number (like 1433) into a friendly protocol and service name (like "TCP, SQL Server").</li>
          <li><strong>Landing Zone Resource Groups and Landing Zone Network mappings</strong> &mdash; tells the app which Azure subscription, resource group, virtual network, subnet, and NSG each server will live in (or already lives in) after migration. This is what supplies each sprint server's <em>new</em> Azure address.</li>
          <li><strong>The migration plan itself</strong> (sprints, waves, and each sprint's status) &mdash; used specifically to work out which servers have <em>already</em> finished migrating, covered in detail below.</li>
        </ul>
        <p>The three views (NSG, Azure Firewall, on-prem) all read from this exact same set of data. Nothing differs between them except the perspective (who is "local" vs "remote," and which direction a connection is labelled) and which connections are considered worth keeping.</p>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-nsg">
        <h2 id="fw-doc-nsg"><Network size={18} /> Azure NSG rules</h2>
        <p>Written from Azure's own point of view: a connection into a sprint server is <strong>Inbound</strong>, a connection out of one is <strong>Outbound</strong> &mdash; no flipping. A sprint server's own side of the rule is represented by the Azure subnet it will live in after migration (from the Landing Zone Network mapping), not its old on-prem IP, since that's the address the rule actually needs to protect once the server has moved.</p>
        <p>Traffic between two sprint servers that are already mapped into the <em>same</em> subnet is left out, because Azure allows traffic within a subnet by default &mdash; an explicit rule for it would be redundant. Each rule gets a sequential priority (starting at 100) and a generated name such as <code>Allow_In_Tcp_1433_sqlhost01</code>.</p>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-azfw">
        <h2 id="fw-doc-azfw"><Shield size={18} /> Azure Firewall rules</h2>
        <p>Azure Firewall protects north-south traffic &mdash; traffic entering or leaving the network, not traffic between two servers that are both already inside it. So by default this view keeps only connections between a sprint server and something outside the sprint (on-prem hosts, office/VPN ranges, or other external systems) and drops every connection where both ends are sprint servers ("east-west" traffic), even across subnets.</p>
        <p>If you specifically also want to see and export east-west (sprint-to-sprint) traffic through Azure Firewall &mdash; for example, if your design routes all traffic through a hub firewall even between servers in the same environment &mdash; turn on the <strong>"Include east-west traffic between sprint servers"</strong> toggle, which only appears for this target. With it on, those server-to-server connections are added back into the rule list, the table, and every export.</p>
        <p>Only rules with a resolved peer address are included in this view (an Azure Firewall rule needs an actual address to filter on, unlike an NSG rule, which can fall back to a subnet default).</p>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-onprem">
        <h2 id="fw-doc-onprem"><Database size={18} /> On-prem firewall rules</h2>
        <p>Written from the on-premises firewall's point of view, which is the mirror image of Azure's: a flow that is <strong>Inbound</strong> to a sprint server in the Azure views becomes <strong>Outbound</strong> from the on-prem firewall, and vice versa. Traffic between two servers in the <em>same sprint</em> is dropped entirely (not just same-subnet, as with NSG) &mdash; once that sprint has migrated, both ends live in Azure and the on-prem firewall never sees that traffic again.</p>
        <p>One extra rule: if a peer server's own sprint has already been migrated (its status is "Closed"), its old on-prem IP is automatically swapped for its current Azure address in the rule, so you're not asked to keep an on-prem firewall rule open for a server that has already moved. See the next section for exactly how that detection works.</p>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-migrated">
        <h2 id="fw-doc-migrated"><GitMerge size={18} /> How the app knows a migration finished, and swaps in the new Azure address</h2>
        <p>This is one of the more important pieces of logic on this page, so here it is step by step, in plain terms:</p>
        <ol className="doc-steps">
          <li><strong>It checks the sprint status.</strong> Every sprint in your migration plan has a status (Not started, In progress, Closed, and so on). The app treats a sprint as "already migrated" only when its status is exactly <strong>Closed</strong>. Every server that belongs to a Closed sprint is added to an internal list of "migrated servers" &mdash; this check is done fresh every time you generate or export rules, so it always reflects the current state of your plan.</li>
          <li><strong>It looks up where that server landed in Azure.</strong> For each migrated server, the app looks at its Landing Zone Network mapping to find the actual Azure subnet (the IP segment/CIDR) it was placed into.</li>
          <li><strong>It also keeps the server's old on-prem IP</strong> (from the server assessment data), purely so it can recognize that IP if it shows up as a raw address in a dependency record or an imported firewall rule.</li>
          <li><strong>When building rules for a different, still-upcoming sprint</strong>, if one of that sprint's servers has a recorded connection to a server that turns out to be on the migrated list &mdash; matched either by server name or by its old on-prem IP &mdash; the app replaces that peer's address in the rule with its new Azure subnet address (labelled, for example, <code>10.40.2.0/24 (migrated)</code>) instead of the stale on-prem IP. The peer is also marked as a "network" rather than a plain host, since you're now really opening a route to an Azure subnet, not a single old server.</li>
        </ol>
        <div className="doc-example">
          <strong>Worked example</strong>
          <p>Sprint 3 (this week's migration) has a server that still regularly calls a licensing server that belongs to Sprint 1. Sprint 1 finished and its status was marked Closed a month ago, and its Landing Zone Network mapping places it in Azure subnet <code>10.40.1.0/24</code>. Instead of generating a rule that opens traffic to the licensing server's old on-prem IP (say <code>10.10.5.20</code>) &mdash; which no longer matters once that server has moved &mdash; every rule set (on-prem, and the imported-rule matching described below) automatically points the rule at <code>10.40.1.0/24</code>, because that's where the traffic actually needs to reach today.</p>
        </div>
        <p>This same "Closed sprint → migrated server → new Azure address" logic is also used when matching against an <em>imported</em> firewall configuration (see the "Matching against an imported firewall export" section below), except there the old CIDR is never silently rewritten &mdash; it's flagged for you to review manually, because a broader imported CIDR might still legitimately cover other addresses besides the migrated server.</p>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-vpn">
        <h2 id="fw-doc-vpn"><Waypoints size={18} /> What happens when a desktop or laptop on the VPN or office network connects</h2>
        <p>Not every connection to a sprint server comes from another server &mdash; plenty come from end-user devices: someone's laptop in the office running a reporting tool, or a remote employee connected over VPN using a management console. These devices aren't in your server assessment list, so the app needs another way to recognize them.</p>
        <p>That's what the <strong>Office and VPN network ranges</strong> (configured on the Core Infrastructure page as CIDR blocks, e.g. <code>10.20.0.0/16</code> for the office, <code>172.16.0.0/20</code> for VPN) are for. For every connection whose remote address isn't a known server, the app checks whether that address falls inside one of those ranges:</p>
        <ul className="doc-plain-list">
          <li>If it does, the rule's remote side is shown as the <strong>whole range</strong> (for example, <code>Office Network 10.20.0.0/16</code>) rather than the one laptop's individual IP address. The connection is treated as a "network" peer rather than an unresolved host.</li>
          <li>This matters for two reasons: first, it correctly summarizes what should really be allowed (an entire office or VPN range reaching a management port, not just the one laptop that happened to connect during the discovery window), and second, it keeps the rule count manageable &mdash; hundreds of different employee laptop IPs collapse into a single, easy-to-read rule instead of hundreds of near-duplicate ones.</li>
          <li>If a remote address doesn't match any known server, core-infrastructure entry, <em>or</em> office/VPN range, it's left as a plain address and marked <strong>unresolved</strong>, so you know to either add it to one of those lists or investigate it before trusting the rule.</li>
        </ul>
        <div className="doc-example">
          <strong>Example</strong>
          <p>Three different employees connect from home over VPN to a sprint server's admin port during the discovery window, from three different VPN-assigned IPs. Because all three addresses fall inside your configured VPN CIDR range, the generated rule shows a single inbound entry with remote peer <code>VPN Network 172.16.0.0/20</code>, rather than three separate host rules for three individual IPs that will change again next time someone connects.</p>
        </div>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-common">
        <h2 id="fw-doc-common"><ListChecks size={18} /> Things all three views have in common</h2>
        <ul className="doc-plain-list">
          <li><strong>Core infrastructure exclusion</strong>: tick the box to drop every connection to a server (or IP) on your core infrastructure list, so shared services don't dominate the output.</li>
          <li><strong>Office/VPN summarization</strong>: any peer address that falls inside one of your configured network ranges is shown as that range's CIDR (for example, "Office Network 10.20.0.0/16") instead of a single address &mdash; see the dedicated section above for exactly how and why.</li>
          <li><strong>Protocol and service lookup</strong>: the port on each connection is matched against the Windows Services/Ports catalog to fill in the protocol (TCP/UDP/ICMP) and a friendly service name; unmatched ports default to TCP.</li>
          <li><strong>Unresolved peers</strong>: a peer that couldn't be matched to an IP, server, or network range is flagged so you can resolve it manually before applying the rule.</li>
          <li><strong>A safety cap</strong> of 6,000 generated rules per request &mdash; if a scope is large enough to exceed it, the result is marked truncated.</li>
        </ul>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-imported">
        <h2 id="fw-doc-imported"><FileCode2 size={18} /> Matching against an imported firewall export</h2>
        <p>If you've imported an existing firewall configuration (an NSG export, a vendor rule export, or similar) on the Firewall Rule Imports page, this page can also show which of those <em>existing</em> rules already cover the sprint's traffic, in the same table layout as the generated rules above. A rule that references the old on-prem IP of a server whose sprint has since migrated is separated into its own "manual review" list &mdash; the CIDR is left untouched (it may legitimately cover other addresses too) but the server's new Azure address is added alongside it, so you can confirm the change is correct before relying on it.</p>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-downloads">
        <h2 id="fw-doc-downloads"><Download size={18} /> Downloading the rules</h2>
        <p>Every target can be exported as an <strong>Excel workbook</strong> (an Overview sheet plus one sheet formatted for the target you picked). <strong>Terraform</strong> and <strong>Bicep</strong> archives are only offered for Azure NSG and Azure Firewall, since on-prem firewalls aren't an Azure resource Terraform or Bicep can create.</p>
        <h3>Azure NSG archive</h3>
        <p>Creates the network security group itself and one security rule per generated allow rule. If the sprint's servers are mapped to specific subnets (Landing Zone Network), the Terraform archive also creates the subnet association automatically; the Bicep archive instead includes a short README with the exact <code>az network vnet subnet update</code> command to run afterward, because Bicep cannot safely modify an existing subnet without restating every one of its other properties.</p>
        <h3>Azure Firewall archive</h3>
        <p>Assumes your Azure Firewall and its Firewall Policy already exist (this is almost always true, since Azure Firewall is normally managed centrally through Azure Firewall Manager in the hub). The archive only adds a new rule collection group to that existing policy &mdash; it does not create the firewall itself. You must supply the policy's name or resource ID; the generated README includes the exact <code>az network firewall policy</code> command to look it up.</p>
        <div className="doc-example">
          <strong>Where the defaults come from</strong>
          <p>Resource group, region, and NSG/subnet names are pre-filled in the downloaded scripts wherever the sprint's servers have a Landing Zone Resource Groups / Landing Zone Network mapping. Any server without a mapping falls back to a generic address placeholder, and is listed by name in the archive's README so you know exactly what still needs mapping.</p>
        </div>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-run">
        <h2 id="fw-doc-run"><Boxes size={18} /> Running the downloaded scripts</h2>
        <p>Every archive includes its own <code>README.md</code> with the exact commands for that download, but the shape is always the same:</p>
        <h3>Terraform</h3>
        <ol className="doc-steps">
          <li>Unzip the archive and open a terminal in that folder.</li>
          <li>Open <code>variables.tf</code> and fill in anything not already defaulted &mdash; for the Azure Firewall archive this is always the existing policy's ID; for the NSG archive, check the resource group/location/name defaults are correct for your subscription.</li>
          <li>Run <code>terraform init</code>, then <code>terraform plan</code> to review exactly what will be created, then <code>terraform apply</code> to create it.</li>
        </ol>
        <h3>Bicep</h3>
        <ol className="doc-steps">
          <li>Unzip the archive.</li>
          <li>Run the <code>az deployment group create</code> command shown in the archive's README, pointing <code>--template-file</code> at <code>main.bicep</code> and supplying the one required parameter (the NSG name, or the existing firewall policy name).</li>
          <li>For an NSG deployment where a subnet association is needed, run the follow-up <code>az network vnet subnet update</code> command from the README once the NSG has been created.</li>
        </ol>
        <div className="doc-warning">
          <AlertTriangle size={16} />
          <p><strong>Review before you apply.</strong> Both formats only ever create an NSG (and its rules) or add a rule collection to an existing Firewall Policy &mdash; they never modify or delete anything else in your subscription. Even so, always run <code>terraform plan</code> (or review the Bicep parameters) before applying, and resolve any rule flagged "unresolved peer" first, since those are placeholders that need a real address.</p>
        </div>
      </section>

      <section className="doc-section" aria-labelledby="fw-doc-scenarios">
        <h2 id="fw-doc-scenarios"><ListChecks size={18} /> Common scenarios</h2>
        <div className="doc-scenario-grid">
          <article className="doc-scenario-card">
            <h3>"I need to raise a change request for the network team before cutover"</h3>
            <p>Pick <strong>On-prem Firewall</strong> for the sprint, download the Excel workbook, and attach it to the change request &mdash; it lists exactly which on-prem rules can be retired or updated once this sprint's servers move.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"I want the actual Azure resources ready to deploy, not just a spreadsheet"</h3>
            <p>Pick <strong>Azure NSG</strong> or <strong>Azure Firewall</strong> and download the Terraform or Bicep archive matching whichever your team already uses for infrastructure.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"Shared services like AD and monitoring are swamping the rule list"</h3>
            <p>Turn on <strong>exclude core infrastructure connections</strong> before generating or downloading &mdash; those connections are removed from every view and every export.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"I already have firewall rules configured and want to know what's missing"</h3>
            <p>Import your existing configuration on the Firewall Rule Imports page first, then come back here &mdash; the page shows which of your existing rules already match the sprint, and separately flags any that need manual review.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"A rule still points at a server that migrated months ago"</h3>
            <p>That's expected and handled automatically for the on-prem view and for imported-rule matching &mdash; the server's current Azure address is substituted (or added alongside the existing CIDR for imported rules) so you can update the real firewall with confidence.</p>
          </article>
          <article className="doc-scenario-card">
            <h3>"Some rules show 'Unresolved'"</h3>
            <p>This means the peer couldn't be matched to a known IP, server, or network range. Resolve it by adding the missing server assessment IP, core infrastructure entry, or office/VPN range, then regenerate.</p>
          </article>
        </div>
      </section>
    </article>
  </div>
}
