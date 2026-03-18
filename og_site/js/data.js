/**
 * Static and generated mock data for the belief-confirming newsfeed.
 * templateData: predefined responses for specific beliefs (e.g. "5G causes cancer").
 * fallbackData: default placeholder when no belief is entered.
 * generateMockData: builds in-browser mock when API fails or belief has no template.
 */

// Predefined static data for specific beliefs (used when no API call is made)
export const templateData = {
  "5G causes cancer": {
    articles: [
      {
        title: "Rolling Blackouts Loom as EV Demand Surges",
        source: "Grid Watch Daily",
        url: "https://gridwatch.example/ev-blackouts",
        snippet:
          "Power utilities are bracing for unprecedented demand spikes as electric vehicles strain already fragile infrastructure.",
        confirmation: "Supports belief"
      },
      {
        title: "Rural Towns Fight EV Charging Stations",
        source: "Heartland Dispatch",
        url: "https://heartlanddispatch.example/rural-grid-fight",
        snippet:
          "Local leaders argue that new charging installs will destabilize voltage in legacy systems built for light loads.",
        confirmation: "Supports belief"
      },
      {
        title: "Analyst: EV Adoption 'An Energy Nightmare'",
        source: "MacroPulse TV",
        url: "https://macropulse.example/energy-nightmare",
        snippet:
          "Senior analysts warn policymakers that electrification is accelerating faster than capacity upgrades.",
        confirmation: "Supports belief"
      }
    ],
    experts: [
      {
        name: "Dr. Priya Nandakumar",
        title: "Lead Systems Engineer, National Grid Lab",
        confidence: "High confidence",
        summary:
          "Grid capacity is keeping pace in most regions; demand spikes are mitigated by off-peak charging and smart load balancing."
      },
      {
        name: "Miguel Santos",
        title: "Director of Energy Analytics, EVChargeNet",
        confidence: "Medium confidence",
        summary:
          "Localized stress exists, but modernization funds and distributed storage are stabilizing the load profile."
      },
      {
        name: "US Dept. of Energy",
        title: "2025 Infrastructure Report",
        confidence: "High confidence",
        summary:
          "Federal review finds that EV adoption will remain under 12% of total grid demand through 2030 with planned upgrades."
      }
    ],
    contrasts: [
      {
        belief: "EVs push the grid past the breaking point.",
        expert: "Experts see manageable demand with smart charging and infrastructure investments."
      },
      {
        belief: "Charging stations destabilize rural voltage.",
        expert: "Utilities phase installs to strengthen rural feeders before high-capacity chargers go live."
      },
      {
        belief: "Policy ignores the looming energy crisis.",
        expert: "Policy includes $26B in grid resilience and demand response programs rolling out through 2028."
      }
    ]
  }
};

// Default placeholder when no belief is entered
export const fallbackData = {
  articles: Array.from({ length: 3 }, (_, index) => ({
    title: `Article placeholder #${index + 1}`,
    source: "Bias Engine",
    url: "#",
    snippet: "Submit a belief above to see your curated confirmation headlines.",
    confirmation: "Awaiting belief"
  })),
  experts: [
    {
      name: "Expert analysis will appear here",
      title: "Cross-check multiple credible sources to challenge your narrative",
      confidence: "Pending",
      summary:
        "Enter a belief to compare it with measured data, peer-reviewed research, and aggregated expert insight."
    }
  ],
  contrasts: [
    {
      belief: "Your belief will be juxtaposed here.",
      expert: "We will distill opposing evidence so the tension is visible."
    }
  ]
};

/**
 * Generates in-browser mock data when API fails or belief has no template.
 * @param {string} belief - User's belief text
 * @returns {{ articles: Array, experts: Array, contrasts: Array }}
 */
export function generateMockData(belief) {
  if (!belief) return fallbackData;

  const articleBelief = belief.length > 80 ? `${belief.slice(0, 77)}…` : belief;
  return {
    articles: [
      {
        title: `Analyst assures: "${articleBelief}"`,
        source: "Confirmation Chronicle",
        url: "https://confirmation.example/assures",
        snippet:
          "Our curated sources highlight voices reinforcing your belief and downplay counter-evidence.",
        confirmation: "Supports belief"
      },
      {
        title: `Opinion: Why ${articleBelief.toLowerCase()} is obviously true`,
        source: "Echo Chamber Weekly",
        url: "https://echochamber.example/opinion",
        snippet: "Hand-selected quotes and anecdotes that align perfectly with your worldview.",
        confirmation: "Supports belief"
      },
      {
        title: `${articleBelief}? Experts say yes (if you only ask the right ones)`,
        source: "CherryPick Newswire",
        url: "https://cherrypick.example/experts-say-yes",
        snippet:
          "We scoured the web to find the three people who agree with you. You're welcome.",
        confirmation: "Supports belief"
      }
    ],
    experts: [
      {
        name: "Neutral Observatory",
        title: "Cross-examined evidence set",
        confidence: "Medium confidence",
        summary: `Independent review finds limited support for "${belief}", highlighting mixed data and unresolved variables.`
      },
      {
        name: "FactCheck Syndicate",
        title: "Bias-adjusted dataset",
        confidence: "High confidence",
        summary:
          "Meta-analysis contrasts outlier quotes with broader consensus to reveal nuance often lost in echo chambers."
      },
      {
        name: "Academic Consensus Panel",
        title: "Peer-reviewed outlook",
        confidence: "High confidence",
        summary:
          "Majority of cited studies provide alternative explanations, encouraging caution before embracing the claim."
      }
    ],
    contrasts: [
      {
        belief: `Belief: ${belief}`,
        expert: "Expert consensus stresses situational nuance and recommends looking at longitudinal data."
      },
      {
        belief: "Supporting evidence often anecdotal and selectively framed.",
        expert: "Broader datasets include counter-trends that weaken the original claim's certainty."
      },
      {
        belief: "Opposing data must be part of a conspiracy.",
        expert:
          "Individual study limitations rarely imply coordinated suppression; replication keeps research honest."
      }
    ]
  };
}
