# Linear App Issue Creator github acton

This action creates a linear sub issue that is related to a linear ticket for a PR.



## Inputs

### `linear-key`
**Required** The linear API key. Default `none`.

### `due-in-days`
Due in days. Default `1`.

### `issue-state`
Issue state (Todo). Default `Todo`.

### `issue-label`
Label assigned to issue (PR Review). Default `none`.

### `priority`
Issue priority. Default `2`.

### `estimate`
Issue estimate. Default `2`.

### `GITHUB_TOKEN`
**Required** Github Token. Default `none`.

### `debug`
Default `false`.


## Outputs

### `url`

The time the ticket was created.

## Example usage

```
name: Linear Issues Creator
on:
  pull_request:
    types: [labeled, unlabeled, closed, opened, reopened]
  pull_request_review:
    types: [submitted]

jobs:
  create-issue:
    runs-on: ubuntu-latest
    steps:
      - name: Linear Issues Creator
        id: linear-issues-creator
        uses: teebu/linear-issue-creator@master
        with:
          linear-key: ${{ secrets.LINEAR_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
          debug: true
```

If the issue is in 'Done' state no action occurs.

- action: `created` PR -> (draft or not) does nothing
- action: `labeled` -> checks the label and if username is found then creates a sub issue assigned to that username and creates message in gh
- action: `unlabeled` -> cancels the ticket for that assigned username
- action: `closed` PR -> sets 'Canceled' state all the sub issues
- action: `closed` PR with merge -> marks all the sub issue for that PR as 'QA'
- action: `reopened` a closed PR -> all the sub issues that are not Done for that PR are set to default state 'Todo'
- action: `submitted` reviewed PR as 'approved' -> sets the sub issue for that gh action sender's linear username as 'QA' (will create issue if one doesn't exist)
- action: `submitted` reviewed PR as 'changes_requested' -> marks the gh action sender's assigned user sub issue and parent issue as 'Changes Requested' (will create issue if one doesn't exist)
- action: `review_requested` (re-requested event) -> finds existing issues with the requested_reviewer's username and sets them to 'Todo' (linear intergration resets parent ticket to review state)


## Release Tags:
```
git tag -a v1.0.1 -m "update version"  
git push origin v1.0.1
```
