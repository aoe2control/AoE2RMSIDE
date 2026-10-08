use super::*;

impl Server {
    pub(super) fn generation_catalog_identity(&self) -> Value {
        self.source_catalog.as_ref().map_or(Value::Null, |catalog| {
            json!({
                "revision": catalog.revision(),
                "entryPath": catalog.entry_path(),
                "catalogHash": hex(&catalog.catalog_hash()),
                "rmsGraphHash": hex(&catalog.rms_graph_hash()),
                "externalAssetHash": hex(&catalog.asset_graph_hash()),
            })
        })
    }

    pub(super) fn generation_diagnostic_context(&self) -> Value {
        json!({
            "catalog": self.generation_catalog_identity(),
            "effectiveCatalogHash": null,
            "entryOverlayHash": null,
        })
    }

    pub(super) fn invalidate_source_catalog(&mut self, params: &Value) -> RequestResult<Notified> {
        if params.get("contractVersion") != Some(&json!({"major":1,"minor":0,"patch":0})) {
            return Err(RequestError::invalid(
                "source catalog diagnostic contract is unsupported",
            ));
        }
        if required(params, "expectedCatalog")? != &self.generation_catalog_identity() {
            return Ok(Notified::default());
        }
        lock(&self.effective_catalog).take();
        *self.source_catalog = None;
        self.rebuild_dependency_graph();
        if !self.editor.modern {
            self.xs.invalidate_closed_inputs();
        }
        Ok(Notified {
            publish: self.documents.keys().cloned().collect(),
            immediate: self.publish_xs_diagnostics(None, true),
            analyze: Vec::new(),
        })
    }
}
