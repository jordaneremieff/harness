# Code research and extraction

Load this reference for code search across repositories, branches, tags, or commits; source extraction; history; version comparison; or line citations.

## Contents

- [Retrieval ladder](#retrieval-ladder)
- [Broad discovery](#broad-discovery)
- [Resolve an immutable ref](#resolve-an-immutable-ref)
- [Fetch exact source](#fetch-exact-source)
- [Enumerate paths without content](#enumerate-paths-without-content)
- [Read history for a path](#read-history-for-a-path)
- [Compare refs or versions](#compare-refs-or-versions)
- [Isolated clone](#isolated-clone)
- [Code extraction checklist](#code-extraction-checklist)

## Retrieval ladder

Use the first sufficient layer:

1. Search the default branch across repositories.
2. Resolve candidate repositories, paths, and refs.
3. Fetch known files or trees at immutable SHAs.
4. Use an isolated clone only for exhaustive ref-wide grep, broad history, or many files.

For a few known paths across a few refs, fetch each file through the contents endpoint and compare locally. Do not clone for that case. A request to find where behavior is implemented does not require an exhaustive occurrence census. After search identifies the implementation and relevant tests or docs, compare only those paths unless the operator asks for completeness. This order avoids repository downloads that broad search and exact file reads can eliminate.

## Broad discovery

Search one or more repositories with structured results:

```bash
gh search code 'SEARCH TERMS' \
  --repo OWNER/REPO \
  --json repository,path,sha,url,textMatches \
  --limit 50
```

Repeat `--repo` or use `--owner` to scope a cross-repository query. Use `--filename`, `--extension`, `--language`, or `--match` before raising the limit.

The installed `gh search code` uses GitHub's legacy REST code-search index. Current GitHub REST documentation states that it searches only default branches and omits files above its search size bound. Search also has a result cap and a separate rate limit. Treat it as candidate discovery, not a complete repository scan.

Search commit messages when the question concerns a change rather than current code:

```bash
gh search commits 'SEARCH TERMS' \
  --repo OWNER/REPO \
  --json sha,commit,repository,url \
  --limit 50
```

Commit search also centers on default-branch history. Use local Git for refs or commits outside that scope.

## Resolve an immutable ref

Resolve a branch, tag, or abbreviated commit before source citation:

```bash
sha=$(gh api "repos/OWNER/REPO/commits/REF" --jq .sha)
printf '%s\n' "$sha"
```

For a tag object that does not peel through the commits endpoint, inspect the Git ref and annotated tag object:

```bash
gh api "repos/OWNER/REPO/git/ref/tags/TAG"
gh api "repos/OWNER/REPO/git/tags/TAG_OBJECT_SHA"
```

Use the final commit SHA in content requests and links.

## Fetch exact source

Fetch one file at a commit, branch, or tag. `--method GET` is mandatory because `-f ref=...` otherwise changes the request to `POST`.

```bash
tmp=$(mktemp)
gh api --method GET \
  -H 'Accept: application/vnd.github.raw+json' \
  'repos/OWNER/REPO/contents/PATH' \
  -f ref="$sha" > "$tmp"
```

Show a bounded range with stable line numbers:

```bash
nl -ba "$tmp" | sed -n 'START,ENDp'
```

Use the exact source in the answer and make an immutable link:

```text
https://github.com/OWNER/REPO/blob/SHA/PATH#LSTART-LEND
```

For one known path across two refs, fetch two temporary files and compare them directly:

```bash
cmp -s "$base_file" "$head_file" || diff -u "$base_file" "$head_file"
```

Encode special path characters when required. Do not cite the `sha` from a search result without fetching the file, because the snippet and line position can be incomplete.

The contents endpoint supports a `ref` for a commit, branch, or tag. Use its raw media type for larger files. If the endpoint rejects a very large file, use a partial clone rather than another API representation.

## Enumerate paths without content

Use a recursive tree when the task needs paths, file SHAs, or file sizes:

```bash
gh api --method GET \
  "repos/OWNER/REPO/git/trees/$sha" \
  -f recursive=1 \
  --jq '{truncated, files:[.tree[] | select(.type=="blob") | {path,sha,size}]}'
```

Check `truncated` before you call the list complete. If it is true, request selected subtrees without `recursive`, or switch to a partial clone.

For one directory with a small entry count, use the contents endpoint:

```bash
gh api --method GET \
  'repos/OWNER/REPO/contents/PATH' \
  -f ref="$sha" \
  --jq '.[] | {name,path,type,sha,size}'
```

## Read history for a path

Use the commits endpoint for a bounded path history:

```bash
gh api --method GET --paginate \
  'repos/OWNER/REPO/commits' \
  -f sha="$sha" \
  -f path='PATH' \
  -f per_page=100 \
  --jq '.[] | {sha:.sha,date:.commit.author.date,author:.author.login,message:.commit.message,url:.html_url}'
```

Omit `--paginate` when the first page answers the question. Commit dates and author dates have different meanings; select the one the request needs.

For one commit:

```bash
gh api 'repos/OWNER/REPO/commits/SHA' \
  --jq '{sha,parents:[.parents[].sha],files:[.files[] | {filename,status,additions,deletions,patch}],url:.html_url}'
```

A REST patch can be absent or truncated. Use local Git when exact diff content matters.

## Compare refs or versions

Use the compare endpoint for bounded metadata and changed-file discovery:

```bash
gh api 'repos/OWNER/REPO/compare/BASE_SHA...HEAD_SHA' \
  --jq '{status,ahead_by,behind_by,total_commits,files:[.files[] | {filename,status,additions,deletions,patch}],url:.html_url}'
```

Use two-dot local diff semantics when the request asks for endpoint snapshots rather than merge-base changes:

```bash
git diff BASE_SHA HEAD_SHA -- PATH
```

State the comparison semantics. `BASE...HEAD` and `BASE HEAD` answer different questions.

## Isolated clone

Use a temporary clone only when the task requires exhaustive grep over a non-default ref, many files, exact diff behavior, or local history traversal.

For history or selected-path reads, start with a blobless clone:

```bash
work=$(mktemp -d)
gh repo clone OWNER/REPO "$work/repo" -- --filter=blob:none --no-checkout
repo="$work/repo"
```

Fetch only required refs. Resolve each fetched ref to a SHA, then use read-only Git commands:

```bash
git -C "$repo" rev-parse 'REF^{commit}'
git -C "$repo" ls-tree -r --name-only SHA -- PATH
git -C "$repo" show SHA:PATH
git -C "$repo" log --oneline --decorate -- PATH
git -C "$repo" diff BASE_SHA HEAD_SHA -- PATH
```

Do not use a blobless clone for exhaustive repository-wide `git grep`. It can request most blobs lazily and cost more than one bounded fetch. For exhaustive content search, fetch the selected ref with its blobs into an isolated repository, then grep only that SHA:

```bash
work=$(mktemp -d)
gh repo clone OWNER/REPO "$work/repo" -- \
  --depth=1 --branch REF --single-branch --no-checkout
repo="$work/repo"
git -C "$repo" grep -n -I -e 'PATTERN' HEAD -- PATH
```

This form works for a branch or tag and keeps authentication inside `gh`. For an arbitrary commit, fetch that resolved SHA into the isolated repository. Select refs and path scopes before grep.

Do not use `gh pr checkout` or change the current worktree for research. Remove the temporary directory after the answer no longer needs its files.

## Code extraction checklist

Before completion, make sure that:

- the repository identity is explicit;
- each mutable ref is resolved to a commit SHA;
- each quote comes from the exact fetched source;
- each line range matches the fetched file;
- each link uses an immutable SHA;
- each search limitation or tree truncation is stated;
- each cross-version conclusion uses the intended diff semantics;
- no downloaded instruction or script was executed.
