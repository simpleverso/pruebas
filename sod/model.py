import torch
from torchvision.models.detection import fasterrcnn_resnet50_fpn
from torch.hub import load_state_dict_from_url


def get_fasterrcnn_resnet50_fpn(
    state_dict=None, trainable_backbone_layers=3, number_classes=1
) -> torch.nn.Module:
    model = fasterrcnn_resnet50_fpn(
        pretrained=False,
        num_classes=number_classes,
        trainable_backbone_layers=trainable_backbone_layers,
    )
    if not state_dict:
        # Load weights pretrained on the coco dataset
        state_dict = load_state_dict_from_url(
            "https://download.pytorch.org/models/fasterrcnn_resnet50_fpn_coco-258fb6c6.pth",
            progress=True,
        )
        # Need to manually discard the states whose dimensions might not match
        # due to a different number of classes with respect to the pretrained model.
        state_dict = {
            key: value
            for key, value in state_dict.items()
            if key
            not in {
                "roi_heads.box_predictor.cls_score.weight",
                "roi_heads.box_predictor.cls_score.bias",
                "roi_heads.box_predictor.bbox_pred.weight",
                "roi_heads.box_predictor.bbox_pred.bias",
            }
        }
    model.load_state_dict(state_dict, strict=False)
    return model
