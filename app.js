const core = require('@actions/core');
const github = require('@actions/github');
const linear = require("@linear/sdk");
const linearClient = new linear.LinearClient({ 'apiKey': process.env.LINEAR_API_KEY });

let statesCache = {};
let branch = process.env.GITHUB_HEAD_REF // "refs/heads/feature/doc-490-evaluate-pull-request-deployment-of"
const payload = JSON.stringify(github.context.payload, undefined, 2)

// todo: fill in values from payload
const PRClosed = false; // simulate a closed PR
const changesRequested = true; // simulate changes requested
const gh_label = 'review_req_yuriy'; // 'review_req_dani3lsz' - display names are case sensitive
//let body = core.getInput('message');

async function main() {
  const issueId = parse_ref(branch);
  console.log('issueId:', issueId);

  const issue = await linearClient.issue(issueId);
  console.log(issue);

  const _teamId = issue._team.id;
  const _parentId = issue.id;
  const _cycleId = issue._cycle && issue._cycle.id || null;
  const desiredState = PRClosed ? 'QA' : 'Todo';
  const desiredStateId = await getStateId(_teamId, desiredState); // Todo | QA
  const createIssueTitle = `🤞 PR Review: ${branch}`;
  const description = `Hey, this is the description of my awesome new feature. Review it asap.
    Go here and review: https://github.com/docuvision/Redacted.ai/pull/1008`;
  const assignUser = parse_user_label(gh_label);

  if (!assignUser) {
    console.log('no user found');
    return;
  }
  // find the user by string
  const user = await linearUserFind(assignUser);
  const userId = user.id;

  // find issue with title with parent id
  const foundIssue = await linearIssueFind(createIssueTitle, _parentId);

  if (!foundIssue) {  // create subissue
    console.log('creating new sub issue');
    await createIssue(null, createIssueTitle, _teamId, _parentId, _cycleId, description, userId, desiredStateId);

  } else if (foundIssue && (userId != foundIssue._assignee.id || foundIssue._state.id != desiredStateId)) {
    // if issue exists but assignee doesnt match, update issue with new assignee's id
    console.log('issue already there, going to update it');
    await updateIssue(foundIssue.id, createIssueTitle, _teamId, _parentId, _cycleId, description, userId, desiredStateId);

  } else if (foundIssue && PRClosed) {
    // set issue to status: QA
    console.log('issue found and PRClosed, going to set it to QA');
    await updateIssue(foundIssue.id, createIssueTitle, _teamId, _parentId, _cycleId, description, userId, desiredStateId);

  } else {
    console.log('issue already exists');
  }

  console.log('done');
}

async function createIssue(
  id = null, title, teamId, parentId, cycleId, description, assigneeId,
  desiredStateId, label = 'PR Review', priority = 2, estimate = 2) {
  // Create a subissue for label and assignee

  const labelId = await getLabelId(teamId, label); // in team, get label id
  const tomorrow = new Date(new Date());
  tomorrow.setDate(tomorrow.getDate() + 1);

  const createPayload = await linearClient.issueCreate(
    {
      id, title, teamId, parentId, cycleId, description, assigneeId, priority, estimate,
      stateId: desiredStateId, // issue status
      dueDate: tomorrow, // looks like its rounding dates
      labelIds: [labelId],
    });

  if (createPayload.success) {
    console.log(createPayload);
    return createPayload;
  } else {
    return new Error("Failed to create issue");
  }
}

async function updateIssue(
  id, title, teamId, parentId, cycleId, description, assigneeId,
  desiredStateId, label = 'PR Review', priority = 2, estimate = 2) {

  const labelId = await getLabelId(teamId, label); // in team, get label id
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const createPayload = await linearClient.issueUpdate(id, {
    title, teamId, parentId, cycleId, description, assigneeId, priority, estimate,
    stateId: desiredStateId, // issue status
    dueDate: tomorrow, // looks like its rounding dates
    labelIds: [labelId],
  });

  if (createPayload.success) {
    console.log(createPayload);
    return createPayload;
  } else {
    return new Error("Failed to update issue");
  }
}

async function linearIssueFind(title, parentId) {
  const { nodes: found } = await linearClient.issueSearch(title);
  if (found.length === 0) return null;

  return found.find((issue) => issue._parent.id === parentId) ?? null;
}

async function linearUserFind(userName) {
  const { nodes: found } = await linearClient.users({
      includeArchived: false,
      first: 100,
      // filter: {
      //     displayName: { eq: userName }
      //   }
    }
  );
  if (found.length === 0) return null;

  return found.find((user) => user.displayName.toLowerCase() == userName.toLowerCase()) || null;
}

// parse title, body, ref of git pull request and get the 'doc-id'
function parse_ref(ref_head) {
  // the pull request GITHUB_REF "doc-490-evaluate-pull-request-deployment-of", "fe-4390-message"
  console.log('ref_head:', ref_head);

  if (!ref_head) return null;

  const re = /\b([a-z]{2,3}-\d+)\b/i;
  // console.log(ref_head.match(re));
  return ref_head.match(re) && ref_head.match(re)[0];
}

// parse gh label for reviewed request
function parse_user_label(label) {
  // review_req_yuriy
  console.log('label:', label);

  if (!label) return null;

  const re = /^review_req_(.*)/;
  // console.log(label.match(re));
  return label.match(re) && label.match(re)[1];
}

async function getStateId(team, desiredState) {
  const availabelStatesInTeam = await linearWorkflowStatesList(team);
  const foundState = availabelStatesInTeam.find((state) => state.name === desiredState);
  if (!foundState) {
    throw new Error(`Not found state "${foundState}" in team ${team.name} ${team.key}`);
  }

  return foundState.id;
}

async function linearWorkflowStatesList(teamId) {
  // create a cache for states for team
  if (statesCache && statesCache[teamId] && statesCache[teamId].length > 0) {
    return statesCache[teamId];
  }
  const { nodes: states } = await linearClient.workflowStates({ first: 100 });
  const teamStates = (
    await Promise.all(
      states.map(async (state) => {
        const found = await state.team;
        if (found.id === teamId) {
          // There is state in required team
          return state;
        }
        return null;
      }),
    )
  ).filter((state) => state !== null);
  statesCache[teamId.key] = teamStates;
  return teamStates;
}

async function getLabelId(teamId, desiredLabel) {
  // get labels for team
  const team = await linearClient.team(teamId);
  const { nodes: labels } = await team.labels();
  label = labels.find((label) => label.name.toLowerCase() === desiredLabel.toLowerCase());
  if (!label) {
    throw new Error(`Not found label "${desiredLabel}" in team ${teamId}`);
  }

  return label.id;
}

// run main
main().catch((error) => {
  console.error(error);
  core.setFailed(error);
  process.exit(-1);
});
