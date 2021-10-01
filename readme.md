# Linear App github acton

This action pots a comment in a related linear ticket

## Inputs

### `message`

**Required** The message you want to be displayed in the comment. Default `"I am a robot"`.

## Outputs

### `time`

The time the ticket was created.

## Example usage

```
- name: Create Linear Comment
id: linear_app
uses: teebu/linear_app@v1.6
with:
  message: |
    Great success!
env:
  LINEAR_API_KEY: KEYHERE
```

## Tags:
git tag -a v1.8 -m "update version"
